import { NextRequest, NextResponse } from "next/server";
import { HttpError, canReadBrief, requireUser } from "@/lib/auth";
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

function requireReader(req: NextRequest, briefId: string) {
  const user = requireUser(req);
  if (!canReadBrief(user, briefId)) {
    return { user: null, deny: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  return { user, deny: null as NextResponse | null };
}

// POST { tag } adds a curated tag to the entry; DELETE { tag } removes it. Both
// return the entry's current tag list. Gated on canReadBrief (collaborative).
export async function POST(
  req: NextRequest,
  props: { params: Promise<{ id: string; entryId: string }> }
) {
  const params = await props.params;
  let gate;
  try {
    gate = requireReader(req, params.id);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (gate.deny) return gate.deny;

  let body: { tag?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
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
    gate = requireReader(req, params.id);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (gate.deny) return gate.deny;

  let body: { tag?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
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
