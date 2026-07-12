import { NextRequest, NextResponse } from "next/server";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { requireGenerativeCanvasWrite } from "@/lib/hermes/canvasRouteAuth";
import { rejectProposal } from "@/lib/hermes/canvasGenerativeGateway";

export const runtime = "nodejs";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string; pid: string }> }) {
  const params = await props.params;
  const user = requireGenerativeCanvasWrite(req, params.id);
  if (user instanceof NextResponse) return user;
  let body: Record<string, unknown>;
  try { body = await parseBoundedJson(req); }
  catch (error) { return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  rejectProposal({ briefId: params.id, userId: user.id, proposedBy: "user", canWrite: true }, params.pid, String(body.reason ?? "Rejected"));
  return NextResponse.json({ ok: true });
}
