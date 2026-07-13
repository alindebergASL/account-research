import { NextRequest, NextResponse } from "next/server";
import { db, type BriefRow } from "@/lib/db";
import {
  HttpError,
  canCollaborateBrief,
  canReadBrief,
  findUserById,
  publicUser,
  requireUser,
} from "@/lib/auth";
import {
  insertJournalEntry,
  listEntryRowsForBrief,
  listRecentEntryRowsForBrief,
  listThreadEntryRows,
  resolveThreadRoot,
  rowToJournalDto,
  type JournalEntryDto,
  type JournalListRow,
} from "@/lib/journal";
import {
  formatJournalSourceLegend,
  runJournalReply,
  sanitizeInlinePromptField,
  sanitizeJournalAssistantText,
  type JournalContextEntry,
} from "@/lib/journalAi";
import { friendlyAnthropicError } from "@/lib/anthropicError";
import { parseSourceLegendEntries } from "@/lib/journalSourceLegend";
import {
  listDocumentsForBriefByIds,
  listDocumentsForEntries,
  listRecentDocumentsForBrief,
} from "@/lib/journalDocuments";
import { listTagsForEntries } from "@/lib/journalEntryTags";
import {
  listEntryIdsMentioningUser,
  listMentionsForEntries,
  syncEntryMentionsFromBody,
} from "@/lib/journalMentions";
import { notifyJournalMentions } from "@/lib/journalMentionNotifications";
import { createMentionNotifications } from "@/lib/notifications";
import {
  isJournalCatchUpWindow,
  journalCatchUpExcludedDocumentKey,
  journalCatchUpScopedDocumentKey,
  loadJournalCatchUpCache,
  computeCockpitSourceFingerprint,
  refreshCockpitSourceFingerprint,
  saveJournalCatchUpCache,
} from "@/lib/journalCatchUpCache";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { assertProviderCallsEnabled, providerAccessErrorResponse } from "@/lib/providerAccess";
import { providerConcurrencyErrorResponse, reserveProviderConcurrency } from "@/lib/providerConcurrency";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY_CHARS = 4000;
const MAX_SCOPED_DOCUMENTS = 5;
const MAX_EXCLUDED_DOCUMENTS = 50;
const MAX_SCOPED_DOCUMENT_ID_CHARS = 128;

function parseDocumentIds(value: unknown, fieldName: string, maxIds: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  if (!value.every((id) => typeof id === "string")) {
    throw new Error(`${fieldName} must contain document ids`);
  }
  const ids = Array.from(new Set(value.map((id) => id.trim()))).filter(Boolean);
  if (ids.length > maxIds) {
    throw new Error(`${fieldName} may include at most ${maxIds} documents`);
  }
  if (ids.some((id) => id.length > MAX_SCOPED_DOCUMENT_ID_CHARS)) {
    throw new Error(`${fieldName} contains an invalid document id`);
  }
  return ids;
}

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

function loadEntryDto(briefId: string, entryId: string): JournalEntryDto {
  const row = db()
    .prepare(
      `SELECT j.*, u.display_name AS author_display_name, u.email AS author_email
         FROM journal_entries j
         LEFT JOIN users u ON u.id = j.user_id
        WHERE j.id = ? AND j.brief_id = ?`,
    )
    .get(entryId, briefId) as JournalListRow;
  const docs = listDocumentsForEntries([entryId]).get(entryId) ?? [];
  const tags = listTagsForEntries([entryId]).get(entryId) ?? [];
  const mentions = listMentionsForEntries([entryId]).get(entryId) ?? [];
  return rowToJournalDto(row, docs, tags, mentions);
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const allRows = listEntryRowsForBrief(params.id);
  // Optional server-side "mentions me" filter. Keeps whole threads intact: a
  // root surfaces when it OR any of its replies mentions the viewer, so the
  // filtered feed never shows an orphaned reply without its root.
  const mentionsMe = req.nextUrl?.searchParams.get("mentions") === "me";
  let rows = allRows;
  if (mentionsMe) {
    const mentionedIds = listEntryIdsMentioningUser(params.id, user.id);
    const matchedThreadRoots = new Set<string>();
    for (const r of allRows) {
      // Only a *live* mentioning entry surfaces its thread. A soft-deleted
      // entry keeps its mention rows but hides them in the DTO, so letting it
      // trigger a match would show a thread with no visible live mention.
      if (r.deleted_at === null && mentionedIds.has(r.id)) {
        matchedThreadRoots.add(r.reply_to ?? r.id);
      }
    }
    rows = allRows.filter((r) => matchedThreadRoots.has(r.reply_to ?? r.id));
  }
  const entryIds = rows.map((r) => r.id);
  const docsByEntry = listDocumentsForEntries(entryIds);
  const tagsByEntry = listTagsForEntries(entryIds);
  const mentionsByEntry = listMentionsForEntries(entryIds);
  return NextResponse.json({
    entries: rows.map((r) =>
      rowToJournalDto(
        r,
        docsByEntry.get(r.id) ?? [],
        tagsByEntry.get(r.id) ?? [],
        mentionsByEntry.get(r.id) ?? [],
      ),
    ),
  });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  // Active non-viewer participants can post, including member-readers. Hide
  // existence behind 404 for users without read access (mirrors comments).
  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!canCollaborateBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  let body: {
    body?: unknown;
    ask_ai?: unknown;
    reply_to?: unknown;
    source_document_ids?: unknown;
    excluded_source_document_ids?: unknown;
    journal_context_since?: unknown;
    journal_catch_up_window?: unknown;
  };
  try {
    body = await parseBoundedJson(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "Empty body" }, { status: 400 });
  }
  if (text.length > MAX_BODY_CHARS) {
    return NextResponse.json(
      { error: `Entry too long (max ${MAX_BODY_CHARS} chars)` },
      { status: 400 },
    );
  }
  // Optional reply target. Normalized to the thread root (single-level
  // threading): a reply to a reply collapses onto the original root.
  const replyToRaw = typeof body.reply_to === "string" ? body.reply_to.trim() : "";
  let replyRoot: string | null = null;
  if (replyToRaw) {
    replyRoot = resolveThreadRoot(params.id, replyToRaw);
    if (!replyRoot) {
      return NextResponse.json({ error: "Reply target not found" }, { status: 400 });
    }
  }
  const askAi = body.ask_ai === true;
  const journalContextSince = askAi && body.journal_context_since !== undefined
    ? Number(body.journal_context_since)
    : null;
  if (journalContextSince !== null && (!Number.isFinite(journalContextSince) || journalContextSince < 0)) {
    return NextResponse.json({ error: "journal_context_since must be a timestamp" }, { status: 400 });
  }
  const catchUpWindow = askAi && body.journal_catch_up_window !== undefined
    ? body.journal_catch_up_window
    : null;
  if (catchUpWindow !== null && !isJournalCatchUpWindow(catchUpWindow)) {
    return NextResponse.json({ error: "journal_catch_up_window must be 24h, 7d, or all" }, { status: 400 });
  }
  const hasScopedDocumentScope = askAi && body.source_document_ids !== undefined;
  let scopedDocumentIds: string[] = [];
  let excludedDocumentIds: string[] = [];
  try {
    scopedDocumentIds = askAi
      ? parseDocumentIds(body.source_document_ids, "source_document_ids", MAX_SCOPED_DOCUMENTS)
      : [];
    excludedDocumentIds = askAi
      ? parseDocumentIds(body.excluded_source_document_ids, "excluded_source_document_ids", MAX_EXCLUDED_DOCUMENTS)
      : [];
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Invalid source document scope" },
      { status: 400 },
    );
  }
  const excludedDocumentSet = new Set(excludedDocumentIds);
  const excludedDocuments = excludedDocumentIds.length > 0
    ? listDocumentsForBriefByIds(params.id, excludedDocumentIds)
    : [];
  const excludedDocumentLegendTexts = new Set(
    excludedDocuments.map((doc) => sanitizeInlinePromptField(doc.filename)),
  );
  const excludedDocumentNeedles = excludedDocuments
    .flatMap((doc) => [doc.id, doc.filename])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const entryMentionsExcludedDocument = (row: JournalListRow): boolean => {
    if (excludedDocumentNeedles.length === 0) return false;
    const bodyText = (row.body ?? "").toLowerCase();
    return excludedDocumentNeedles.some((needle) => bodyText.includes(needle));
  };
  const effectiveScopedDocumentIds = scopedDocumentIds.filter((id) => !excludedDocumentSet.has(id));
  if (effectiveScopedDocumentIds.length > 0) {
    const scopedDocuments = listDocumentsForBriefByIds(params.id, effectiveScopedDocumentIds);
    if (scopedDocuments.length !== effectiveScopedDocumentIds.length) {
      return NextResponse.json(
        { error: "Selected source document was not found" },
        { status: 400 },
      );
    }
  }

  if (!askAi) {
    const userEntryId = insertJournalEntry({
      briefId: params.id,
      userId: user.id,
      authorType: "user",
      body: text,
      replyTo: replyRoot,
    });
    const mentionedUserIds = syncEntryMentionsFromBody({ briefId: params.id, entryId: userEntryId, body: text });
    // In-app inbox (synchronous, reliable) + email (fire-and-forget). Both skip
    // the author and target everyone newly mentioned.
    createMentionNotifications({ briefId: params.id, entryId: userEntryId, actorId: user.id, recipientUserIds: mentionedUserIds });
    void notifyJournalMentions({
      briefId: params.id,
      entryId: userEntryId,
      body: text,
      createdAt: Date.now(),
      authorId: user.id,
      authorDisplayName: user.display_name,
      authorEmail: user.email,
      mentionedUserIds,
    });
    const userEntry = loadEntryDto(params.id, userEntryId);
    return NextResponse.json({ entries: [userEntry] });
  }

  const catchUpCacheFingerprint = catchUpWindow ? computeCockpitSourceFingerprint(params.id) : null;
  const catchUpCacheExcludedKey = catchUpWindow
    ? journalCatchUpExcludedDocumentKey(excludedDocumentIds)
    : "";
  const catchUpCacheScopedKey = catchUpWindow
    ? journalCatchUpScopedDocumentKey(effectiveScopedDocumentIds, hasScopedDocumentScope)
    : "";
  // A threaded reply always computes fresh thread-scoped context, so it must
  // not be served (or seed) the brief-wide catch-up cache.
  const catchUpCacheHit = catchUpWindow && catchUpCacheFingerprint && !replyRoot
    ? loadJournalCatchUpCache({
        briefId: params.id,
        window: catchUpWindow,
        contextSince: journalContextSince,
        excludedDocumentKey: catchUpCacheExcludedKey,
        scopedDocumentKey: catchUpCacheScopedKey,
        cockpitSourceFingerprint: catchUpCacheFingerprint,
      })
    : null;

  let releaseProviderReservation: (() => void) | null = null;
  if (!catchUpCacheHit) {
    try {
      assertProviderCallsEnabled();
      releaseProviderReservation = reserveProviderConcurrency(`brief:${params.id}`);
    } catch (error) {
      return providerAccessErrorResponse(error) ?? providerConcurrencyErrorResponse(error)
        ?? NextResponse.json({ error: "AI provider access is temporarily unavailable" }, { status: 503 });
    }
  }

  try {
  if (catchUpWindow) refreshCockpitSourceFingerprint(params.id);
  const userEntryId = insertJournalEntry({
    briefId: params.id,
    userId: user.id,
    authorType: "user",
    body: text,
    replyTo: replyRoot,
  });
  const mentionedUserIds = syncEntryMentionsFromBody({ briefId: params.id, entryId: userEntryId, body: text });
  createMentionNotifications({ briefId: params.id, entryId: userEntryId, actorId: user.id, recipientUserIds: mentionedUserIds });
  void notifyJournalMentions({
    briefId: params.id,
    entryId: userEntryId,
    body: text,
    createdAt: Date.now(),
    authorId: user.id,
    authorDisplayName: user.display_name,
    authorEmail: user.email,
    mentionedUserIds,
  });
  const userEntry = loadEntryDto(params.id, userEntryId);
  // The assistant reply joins the same thread: the explicit reply root when
  // threading, otherwise the just-posted user entry (which becomes the root).
  const assistantReplyTo = replyRoot ?? userEntryId;

  if (catchUpCacheHit) {
    const aiEntryId = insertJournalEntry({
      briefId: params.id,
      userId: user.id,
      authorType: "assistant",
      body: catchUpCacheHit.summary_text,
      replyTo: assistantReplyTo,
    });
    const aiEntry = loadEntryDto(params.id, aiEntryId);
    return NextResponse.json({ entries: [userEntry, aiEntry], ai_cache_hit: true });
  }

  // AI participation path. A model failure must NOT lose the user's entry: we
  // return the persisted user entry plus a friendly ai_error instead of 500.
  const briefRow = db()
    .prepare(`SELECT brief_json FROM briefs WHERE id = ?`)
    .get(params.id) as Pick<BriefRow, "brief_json"> | undefined;
  if (!briefRow) {
    return NextResponse.json({
      entries: [userEntry],
      ai_error: "Brief not found",
    });
  }
  let briefJson: unknown;
  try {
    briefJson = JSON.parse(briefRow.brief_json);
  } catch {
    return NextResponse.json({
      entries: [userEntry],
      ai_error: "Stored brief JSON is corrupt",
    });
  }

  // Build context from the recent non-deleted feed including the just-posted
  // user entry. Query a bounded slice so large journals do not make assistant
  // requests increasingly expensive over time. When replying within a thread,
  // that thread's entries are merged in first (and exempt from the recency
  // cutoff) so the assistant stays grounded in the sub-conversation — then the
  // recent feed fills in the rest ("both").
  const recentEntryRows = listRecentEntryRowsForBrief(params.id);
  const threadEntryRows = replyRoot ? listThreadEntryRows(params.id, replyRoot) : [];
  const threadIdSet = new Set(threadEntryRows.map((row) => row.id));
  const mergedSeen = new Set<string>();
  const mergedEntryRows = [...threadEntryRows, ...recentEntryRows]
    .filter((row) => {
      if (mergedSeen.has(row.id)) return false;
      mergedSeen.add(row.id);
      return true;
    })
    .sort((a, b) => a.created_at - b.created_at);
  const documentsByRecentEntry = listDocumentsForEntries(mergedEntryRows.map((row) => row.id));
  const entryUsesExcludedDocumentLegend = (row: JournalListRow): boolean => {
    if (row.author_type !== "assistant" || excludedDocumentLegendTexts.size === 0) return false;
    return parseSourceLegendEntries(row.body ?? "").some(
      (entry) => entry.kind === "document" && excludedDocumentLegendTexts.has(entry.text.trim()),
    );
  };
  const contextEntries: JournalContextEntry[] = mergedEntryRows
    .filter((row) => {
      const inThread = threadIdSet.has(row.id);
      if (!inThread && journalContextSince !== null && row.created_at < journalContextSince) return false;
      if (entryMentionsExcludedDocument(row)) return false;
      if (entryUsesExcludedDocumentLegend(row)) return false;
      const attachedDocuments = documentsByRecentEntry.get(row.id) ?? [];
      return !attachedDocuments.some((doc) => excludedDocumentSet.has(doc.id));
    })
    .map((r) => ({
      author_type: r.author_type,
      author_display_name:
        r.author_type === "assistant" ? "Assistant" : r.author_display_name,
      body: r.body,
      created_at: r.created_at,
      // Thread entries are exempt from the context cap (see selectJournalContext).
      priority: threadIdSet.has(r.id),
    }));

  const documents = hasScopedDocumentScope
    ? effectiveScopedDocumentIds.length > 0
      ? listDocumentsForBriefByIds(params.id, effectiveScopedDocumentIds)
      : []
    : listRecentDocumentsForBrief(params.id).filter((doc) => !excludedDocumentSet.has(doc.id));

  try {
    const result = await runJournalReply({
      brief_json: briefJson,
      entries: contextEntries,
      documents,
    });
    const safeReplyText = sanitizeJournalAssistantText(result.text);
    const assistantBody = `${safeReplyText}${formatJournalSourceLegend(
      {
        brief_json: briefJson,
        entries: contextEntries,
        documents,
      },
      safeReplyText,
    )}`;
    const persistAssistantOutcome = db().transaction(() => {
      const activeUserRow = findUserById(user.id);
      if (!activeUserRow) {
        throw new HttpError(403, { error: "Not authorized" });
      }
      const activeUser = publicUser(activeUserRow);
      if (
        !canReadBrief(activeUser, params.id) ||
        !canCollaborateBrief(activeUser, params.id)
      ) {
        throw new HttpError(403, { error: "Not authorized" });
      }

      const aiEntryId = insertJournalEntry({
        briefId: params.id,
        userId: activeUser.id,
        authorType: "assistant",
        body: assistantBody,
        replyTo: assistantReplyTo,
      });
      if (catchUpWindow && !replyRoot) {
        const catchUpSaveFingerprint = refreshCockpitSourceFingerprint(params.id);
        saveJournalCatchUpCache({
          briefId: params.id,
          window: catchUpWindow,
          contextSince: journalContextSince,
          excludedDocumentKey: catchUpCacheExcludedKey,
          scopedDocumentKey: catchUpCacheScopedKey,
          cockpitSourceFingerprint: catchUpSaveFingerprint,
          summaryText: assistantBody,
          sourceEntryId: aiEntryId,
        });
      }
      return aiEntryId;
    });
    const aiEntryId = persistAssistantOutcome();
    const aiEntry = loadEntryDto(params.id, aiEntryId);
    return NextResponse.json({ entries: [userEntry, aiEntry], ai_cache_hit: false });
  } catch (err) {
    const denied = authError(err);
    if (denied) return denied;
    const limited = providerAccessErrorResponse(err) ?? providerConcurrencyErrorResponse(err);
    if (limited) return limited;
    return NextResponse.json({
      entries: [userEntry],
      ai_error: friendlyAnthropicError(err, "Journal assistant"),
    });
  }
  } finally {
    releaseProviderReservation?.();
  }
}
