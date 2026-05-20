import { NextRequest, NextResponse } from "next/server";
import { requireGenerativeCanvasWrite } from "@/lib/hermes/canvasRouteAuth";
import { withdrawCapabilityProposal } from "@/lib/hermes/canvasGenerativeGateway";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: { id: string; cpid: string } }) {
  const user = requireGenerativeCanvasWrite(req, params.id);
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => ({}));
  withdrawCapabilityProposal({ briefId: params.id, userId: user.id, proposedBy: "user", canWrite: true }, params.cpid, String(body.reason ?? "Withdrawn"));
  return NextResponse.json({ ok: true });
}
