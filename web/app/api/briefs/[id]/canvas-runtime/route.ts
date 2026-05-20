import { NextRequest, NextResponse } from "next/server";
import { requireGenerativeCanvasRead } from "@/lib/hermes/canvasRouteAuth";
import { getCurrentCanvasDocument, listCapabilityProposals, listProposals } from "@/lib/hermes/canvasGenerativeGateway";
import { summarizeCanvasProposal, summarizeCapabilityProposal } from "@/lib/hermes/canvasProposalSummary";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = requireGenerativeCanvasRead(req, params.id);
  if (user instanceof NextResponse) return user;
  const current = getCurrentCanvasDocument(params.id);
  const proposals = listProposals({ briefId: params.id });
  const capabilityProposals = listCapabilityProposals({ briefId: params.id });
  return NextResponse.json({
    document: current.document,
    state_version: current.stateVersion,
    proposals,
    capability_proposals: capabilityProposals,
    proposal_summaries: proposals.map((p) => summarizeCanvasProposal(p, current.stateVersion)),
    capability_proposal_summaries: capabilityProposals.map((p) => summarizeCapabilityProposal(p, params.id)),
  });
}
