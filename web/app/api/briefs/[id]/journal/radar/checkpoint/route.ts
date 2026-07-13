import { NextRequest, NextResponse } from "next/server";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { HttpError, canCollaborateBrief, canReadBrief, requireUser } from "@/lib/auth";
import {
  JournalRadarStaleManifestError,
  saveJournalRadarCheckpoint,
} from "@/lib/journalRadarCheckpoints";

export const runtime = "nodejs";

function authError(error: unknown) {
  return error instanceof HttpError ? NextResponse.json(error.body, { status: error.status }) : null;
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
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
  if (!canCollaborateBrief(user, params.id)) return NextResponse.json({ error: "Not authorized" }, { status: 403 });

  let body: unknown;
  try {
    body = await parseBoundedJson(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  if (typeof input.manifest_hash !== "string" || !/^[a-f0-9]{64}$/.test(input.manifest_hash)
      || !Number.isInteger(input.manifest_schema_version)) {
    return NextResponse.json({ error: "manifest_hash and manifest_schema_version are required" }, { status: 400 });
  }

  try {
    return NextResponse.json(saveJournalRadarCheckpoint({
      briefId: params.id,
      userId: user.id,
      expectedHash: input.manifest_hash,
      expectedSchemaVersion: input.manifest_schema_version as number,
    }));
  } catch (error: any) {
    if (error instanceof JournalRadarStaleManifestError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        manifest_hash: error.currentHash,
        manifest_schema_version: error.currentSchemaVersion,
      }, { status: 409 });
    }
    const message = String(error?.message ?? "");
    if (/Journal radar manifest is \d+ bytes; maximum is \d+/.test(message)) {
      return NextResponse.json({ error: "Journal radar history is too large to review safely" }, { status: 413 });
    }
    return NextResponse.json({ error: "Failed to save review checkpoint" }, { status: 500 });
  }
}
