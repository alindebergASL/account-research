import { NextRequest, NextResponse } from "next/server";
import { HttpError, canCollaborateBrief, canReadBrief, requireUser } from "@/lib/auth";
import { setEntryPinned } from "@/lib/journal";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) return NextResponse.json(e.body, { status: e.status });
  return null;
}

// Pin (POST) / unpin (DELETE) a journal entry. Team-wide and gated on ordinary
// collaboration authority, so member-readers can organize the shared feed but
// global viewers cannot mutate it.
async function setPin(
  req: NextRequest,
  params: { id: string; entryId: string },
  pinned: boolean,
) {
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
  const ok = setEntryPinned({
    briefId: params.id,
    entryId: params.entryId,
    pinned,
    userId: user.id,
  });
  if (!ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ pinned });
}

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ id: string; entryId: string }> }
) {
  const params = await props.params;
  return setPin(req, params, true);
}

export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ id: string; entryId: string }> }
) {
  const params = await props.params;
  return setPin(req, params, false);
}
