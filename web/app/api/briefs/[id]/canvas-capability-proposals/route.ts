import { NextRequest, NextResponse } from "next/server";
import { requireGenerativeCanvasRead } from "@/lib/hermes/canvasRouteAuth";
import { listCapabilityProposals } from "@/lib/hermes/canvasGenerativeGateway";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = requireGenerativeCanvasRead(req, params.id);
  if (user instanceof NextResponse) return user;
  return NextResponse.json({ capability_proposals: listCapabilityProposals({ briefId: params.id }) });
}
