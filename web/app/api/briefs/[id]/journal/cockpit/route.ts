import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, canReadBrief, requireUser } from "@/lib/auth";
import { listReviewCandidates } from "@/lib/journalReviewCandidates";
import {
  buildJournalCockpitReadModel,
  saveJournalCockpitReadModel,
} from "@/lib/journalCockpitReadModel";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

function briefUpdatedAt(briefId: string): number | null {
  const row = db()
    .prepare(`SELECT created_at FROM briefs WHERE id = ?`)
    .get(briefId) as { created_at: number } | undefined;
  return row?.created_at ?? null;
}

function latestJournalEntryAt(briefId: string): number | null {
  const row = db()
    .prepare(
      `SELECT MAX(COALESCE(edited_at, created_at)) AS latest
         FROM journal_entries
        WHERE brief_id = ? AND deleted_at IS NULL`,
    )
    .get(briefId) as { latest: number | null } | undefined;
  return row?.latest ?? null;
}

function latestSourceUpdatedAt(briefId: string): number | null {
  const row = db()
    .prepare(
      `SELECT MAX(d.created_at) AS latest
         FROM journal_documents d
         JOIN journal_entries j ON j.id = d.journal_entry_id
        WHERE d.brief_id = ?
          AND j.brief_id = ?
          AND j.deleted_at IS NULL`,
    )
    .get(briefId, briefId) as { latest: number | null } | undefined;
  return row?.latest ?? null;
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

  const model = buildJournalCockpitReadModel({
    briefId: params.id,
    candidates: listReviewCandidates(params.id),
    invalidation: {
      briefUpdatedAt: briefUpdatedAt(params.id),
      latestJournalEntryAt: latestJournalEntryAt(params.id),
      latestSourceUpdatedAt: latestSourceUpdatedAt(params.id),
    },
  });
  saveJournalCockpitReadModel(model);
  return NextResponse.json({ model });
}
