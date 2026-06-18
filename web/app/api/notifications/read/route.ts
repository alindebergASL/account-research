import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
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
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.all === true) {
    const marked = markAllNotificationsRead(s.user.id);
    return NextResponse.json({ marked, unread_count: countUnreadNotifications(s.user.id) });
  }
  if (Array.isArray(body.ids)) {
    const ids = body.ids.filter((id): id is string => typeof id === "string");
    const marked = markNotificationsRead(s.user.id, ids);
    return NextResponse.json({ marked, unread_count: countUnreadNotifications(s.user.id) });
  }
  return NextResponse.json({ error: "Provide ids[] or all:true" }, { status: 400 });
}
