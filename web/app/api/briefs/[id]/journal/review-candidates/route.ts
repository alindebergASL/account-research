import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, canCollaborateBrief, canReadBrief, requireUser } from "@/lib/auth";
import {
  insertReviewCandidate,
  listReviewCandidates,
  parseCreateReviewCandidateInput,
} from "@/lib/journalReviewCandidates";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

function sourceEntryBelongsToAssistantReply(briefId: string, entryId: string): boolean {
  const row = db()
    .prepare(
      `SELECT id FROM journal_entries
        WHERE id = ?
          AND brief_id = ?
          AND author_type = 'assistant'
          AND reply_to IS NOT NULL
          AND deleted_at IS NULL`,
    )
    .get(entryId, briefId);
  return !!row;
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
  return NextResponse.json({ candidates: listReviewCandidates(params.id) });
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
  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!canCollaborateBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  let input;
  try {
    input = parseCreateReviewCandidateInput(body);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Invalid review candidate" },
      { status: 400 },
    );
  }

  if (input.source_entry_id && !sourceEntryBelongsToAssistantReply(params.id, input.source_entry_id)) {
    return NextResponse.json(
      { error: "source_entry_id must reference a saved assistant reply" },
      { status: 400 },
    );
  }

  const candidate = insertReviewCandidate({
    briefId: params.id,
    userId: user.id,
    ...input,
  });
  return NextResponse.json({ candidate });
}
