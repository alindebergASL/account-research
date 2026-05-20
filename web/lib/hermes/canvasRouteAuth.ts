import { NextResponse, type NextRequest } from "next/server";
import { HttpError, canReadBrief, canWriteBrief, requireUser, type PublicUser } from "../auth";
import { hermesGenerativeCanvasEnabled } from "./config";

export function authError(e: unknown): NextResponse | null {
  if (e instanceof HttpError) return NextResponse.json(e.body, { status: e.status });
  return null;
}

export function requireGenerativeCanvasRead(req: NextRequest, briefId: string): PublicUser | NextResponse {
  if (!hermesGenerativeCanvasEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const user = requireUser(req);
    if (!canReadBrief(user, briefId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return user;
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
}

export function requireGenerativeCanvasWrite(req: NextRequest, briefId: string): PublicUser | NextResponse {
  const user = requireGenerativeCanvasRead(req, briefId);
  if (user instanceof NextResponse) return user;
  if (!canWriteBrief(user, briefId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return user;
}
