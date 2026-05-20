import { NextRequest, NextResponse } from "next/server";
import { requireGenerativeCanvasRead } from "@/lib/hermes/canvasRouteAuth";
import { listProposals } from "@/lib/hermes/canvasGenerativeGateway";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = requireGenerativeCanvasRead(req, params.id);
  if (user instanceof NextResponse) return user;
  const url = new URL(req.url);
  return NextResponse.json({ proposals: listProposals({ briefId: params.id }, { status: url.searchParams.get("status") ?? undefined, layer: url.searchParams.get("layer") ?? undefined }) });
}
