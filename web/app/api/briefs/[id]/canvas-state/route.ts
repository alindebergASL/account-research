// Auth-gated durable Canvas state read endpoint.
//
// Public share routes must not call this. It returns the latest Hermes
// canvas_states row when present so the client Canvas view can refresh
// after chat/runtime events without reloading the whole brief page.

import { NextRequest, NextResponse } from "next/server";
import {
  HttpError,
  canReadBrief,
  requireUser,
} from "@/lib/auth";
import { getCanvasState } from "@/lib/canvas/state";

export const runtime = "nodejs";

function authError(e: unknown): NextResponse | null {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
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

  const state = getCanvasState(params.id);
  if (!state) {
    return NextResponse.json({ canvas: null, version: 0 });
  }

  return NextResponse.json({
    canvas: state.canvas,
    source: state.source,
    version: state.version,
    updated_at: state.updated_at,
  });
}
