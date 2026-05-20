import { NextRequest, NextResponse } from "next/server";
import { requireGenerativeCanvasWrite } from "@/lib/hermes/canvasRouteAuth";
import { markCapabilityPromoted } from "@/lib/hermes/canvasGenerativeGateway";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: { id: string; cpid: string } }) {
  const user = requireGenerativeCanvasWrite(req, params.id);
  if (user instanceof NextResponse) return user;
  if (user.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const registeredWidgetKind = String(body.promoted_widget_kind ?? "");
  if (!registeredWidgetKind) return NextResponse.json({ error: "promoted_widget_kind required" }, { status: 400 });
  markCapabilityPromoted({ briefId: params.id, userId: user.id, proposedBy: "user", canWrite: true }, params.cpid, registeredWidgetKind);
  return NextResponse.json({ ok: true });
}
