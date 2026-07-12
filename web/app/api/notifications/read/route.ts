import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import {
  countUnreadNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
} from "@/lib/notifications";

export const runtime = "nodejs";

// POST /api/notifications/read
//   body { all: true }       → mark every unread notification read
//   body { ids: string[] }   → mark the listed notifications read
// Scoped to the authenticated user. Returns the resulting unread_count.
export async function POST(req: NextRequest) {
  const s = getSession(req);
  if (!s) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  let body: { all?: unknown; ids?: unknown };
  try {
    body = await parseBoundedJson(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.all === true) {
    const marked = markAllNotificationsRead(s.user.id);
    return NextResponse.json({ marked, unread_count: countUnreadNotifications(s.user.id) });
  }
  if (Array.isArray(body.ids)) {
    // Dedupe and cap so a pathological payload can't blow up the IN (...) clause.
    const ids = [
      ...new Set(body.ids.filter((id): id is string => typeof id === "string")),
    ].slice(0, 500);
    const marked = markNotificationsRead(s.user.id, ids);
    return NextResponse.json({ marked, unread_count: countUnreadNotifications(s.user.id) });
  }
  return NextResponse.json({ error: "Provide ids[] or all:true" }, { status: 400 });
}
