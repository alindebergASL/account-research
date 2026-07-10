import { NextRequest, NextResponse } from "next/server";
import { requireGenerativeCanvasRead } from "@/lib/hermes/canvasRouteAuth";
import { getCapabilityProposal } from "@/lib/hermes/canvasGenerativeGateway";

export const runtime = "nodejs";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string; cpid: string }> }) {
  const params = await props.params;
  const user = requireGenerativeCanvasRead(req, params.id);
  if (user instanceof NextResponse) return user;
  const proposal = getCapabilityProposal({ briefId: params.id }, params.cpid);
  if (!proposal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ capability_proposal: proposal }, { headers: { "X-Content-Type-Options": "nosniff" } });
}
