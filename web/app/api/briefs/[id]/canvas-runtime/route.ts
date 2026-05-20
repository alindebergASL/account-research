import { NextRequest, NextResponse } from "next/server";
import { requireGenerativeCanvasRead } from "@/lib/hermes/canvasRouteAuth";
import { getCurrentCanvasDocument, listCapabilityProposals, listProposals } from "@/lib/hermes/canvasGenerativeGateway";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = requireGenerativeCanvasRead(req, params.id);
  if (user instanceof NextResponse) return user;
  const current = getCurrentCanvasDocument(params.id);
  return NextResponse.json({
    document: current.document,
    state_version: current.stateVersion,
    proposals: listProposals({ briefId: params.id }),
    capability_proposals: listCapabilityProposals({ briefId: params.id }),
  });
}
