import { NextRequest, NextResponse } from "next/server";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { HttpError, canCollaborateBrief, canReadBrief, requireUser } from "@/lib/auth";
import {
  addEntryTag,
  parseJournalEntryTag,
  removeEntryTag,
} from "@/lib/journalEntryTags";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) return NextResponse.json(e.body, { status: e.status });
  return null;
}

function requireCollaborator(req: NextRequest, briefId: string) {
  const user = requireUser(req);
  if (!canReadBrief(user, briefId)) {
    return { user: null, deny: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  if (!canCollaborateBrief(user, briefId)) {
    return { user: null, deny: NextResponse.json({ error: "Not authorized" }, { status: 403 }) };
  }
  return { user, deny: null as NextResponse | null };
}

// POST { tag } adds a curated tag to the entry; DELETE { tag } removes it. Both
// return the entry's current tag list. Gated on ordinary collaboration access.
export async function POST(
  req: NextRequest,
  props: { params: Promise<{ id: string; entryId: string }> }
) {
  const params = await props.params;
  let gate;
  try {
    gate = requireCollaborator(req, params.id);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (gate.deny) return gate.deny;

  let body: { tag?: unknown };
  try {
    body = await parseBoundedJson(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const tag = parseJournalEntryTag(body.tag);
    const tags = addEntryTag({
      briefId: params.id,
      entryId: params.entryId,
      tag,
      userId: gate.user!.id,
    });
    return NextResponse.json({ tags });
  } catch (e: any) {
    const message = e?.message || "Invalid tag";
    return NextResponse.json({ error: message }, { status: message === "entry not found" ? 404 : 400 });
  }
}

export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ id: string; entryId: string }> }
) {
  const params = await props.params;
  let gate;
  try {
    gate = requireCollaborator(req, params.id);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (gate.deny) return gate.deny;

  let body: { tag?: unknown };
  try {
    body = await parseBoundedJson(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const tag = parseJournalEntryTag(body.tag);
    const tags = removeEntryTag({ briefId: params.id, entryId: params.entryId, tag });
    return NextResponse.json({ tags });
  } catch (e: any) {
    const message = e?.message || "Invalid tag";
    return NextResponse.json({ error: message }, { status: message === "entry not found" ? 404 : 400 });
  }
}
