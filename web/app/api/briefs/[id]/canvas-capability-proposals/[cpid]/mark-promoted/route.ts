import { NextRequest, NextResponse } from "next/server";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { requireGenerativeCanvasWrite } from "@/lib/hermes/canvasRouteAuth";
import { markCapabilityPromoted } from "@/lib/hermes/canvasGenerativeGateway";

export const runtime = "nodejs";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string; cpid: string }> }) {
  const params = await props.params;
  const user = requireGenerativeCanvasWrite(req, params.id);
  if (user instanceof NextResponse) return user;
  if (user.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });
  let body: Record<string, unknown>;
  try { body = await parseBoundedJson(req); }
  catch (error) { return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const registeredWidgetKind = String(body.promoted_widget_kind ?? "");
  if (!registeredWidgetKind) return NextResponse.json({ error: "promoted_widget_kind required" }, { status: 400 });
  markCapabilityPromoted({ briefId: params.id, userId: user.id, proposedBy: "user", canWrite: true }, params.cpid, registeredWidgetKind);
  return NextResponse.json({ ok: true });
}
