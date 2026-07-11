import { NextRequest, NextResponse } from "next/server";
import { requireGenerativeCanvasWrite } from "@/lib/hermes/canvasRouteAuth";
import { approveProposal } from "@/lib/hermes/canvasGenerativeGateway";

export const runtime = "nodejs";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string; pid: string }> }) {
  const params = await props.params;
  const user = requireGenerativeCanvasWrite(req, params.id);
  if (user instanceof NextResponse) return user;
  try {
    approveProposal({ briefId: params.id, userId: user.id, proposedBy: "user", canWrite: true }, params.pid);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message ?? e) }, { status: 400 });
  }
}
