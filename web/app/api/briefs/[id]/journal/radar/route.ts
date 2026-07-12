import { NextRequest, NextResponse } from "next/server";
import { HttpError, canReadBrief, requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { compareJournalRadarManifests } from "@/lib/journalRadar";
import { readJournalRadarCheckpoint } from "@/lib/journalRadarCheckpoints";
import { buildJournalRadarManifest } from "@/lib/journalRadarManifest";

export const runtime = "nodejs";

function authError(error: unknown) {
  return error instanceof HttpError ? NextResponse.json(error.body, { status: error.status }) : null;
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let user;
  try {
    user = requireUser(req, { refreshSession: false });
  } catch (error) {
    const response = authError(error);
    if (response) return response;
    throw error;
  }
  if (!canReadBrief(user, params.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const connection = db();
    const readSnapshot = connection.transaction(() => {
      const current = buildJournalRadarManifest(params.id, connection);
      const checkpoint = readJournalRadarCheckpoint(params.id, user.id, connection);
      return { current, checkpoint };
    });
    // A read transaction gives the seven-table manifest and checkpoint one
    // SQLite snapshot without modifying application state.
    const { current, checkpoint } = readSnapshot.deferred();
    const reviewState = compareJournalRadarManifests({
      checkpoint: checkpoint.state === "valid" ? checkpoint.manifest : null,
      current: current.manifest,
      reviewedAt: checkpoint.state === "valid" ? checkpoint.reviewed_at : null,
      noCheckpointReason: checkpoint.state === "missing" ? "missing" : "incompatible",
    });
    return NextResponse.json({
      manifest_hash: current.hash,
      manifest_schema_version: current.manifest.schema_version,
      review_state: reviewState,
    });
  } catch (error: any) {
    const message = String(error?.message ?? "");
    if (/Journal radar manifest is \d+ bytes; maximum is \d+/.test(message)) {
      return NextResponse.json({ error: "Journal radar history is too large to review safely" }, { status: 413 });
    }
    return NextResponse.json({ error: "Failed to build Journal radar" }, { status: 500 });
  }
}
