import { NextRequest, NextResponse } from "next/server";
import { HttpError, canReadBrief, requireUser } from "@/lib/auth";
import { listBriefMembers, memberHandle } from "@/lib/journalMentions";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) return NextResponse.json(e.body, { status: e.status });
  return null;
}

// GET → the brief's members (owner + shares) for the journal @mention
// autocomplete. Read access only; mirrors the rest of the journal surface in
// hiding existence behind 404 for non-readers. `handle` is the token to insert.
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
  const members = listBriefMembers(params.id).map((m) => ({
    id: m.id,
    display_name: m.display_name,
    email: m.email,
    handle: memberHandle(m),
  }));
  return NextResponse.json({ members });
}
