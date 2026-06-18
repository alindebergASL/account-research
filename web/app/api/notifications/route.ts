import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  countUnreadNotifications,
  listNotifications,
} from "@/lib/notifications";

export const runtime = "nodejs";

// GET /api/notifications
//   ?count=1        → { unread_count } only (cheap badge poll)
//   ?unread=1       → list only unread
//   ?limit=N        → cap the list (default 30, max 100)
// Always returns unread_count so the client can refresh the badge from the
// same response after rendering the panel.
export async function GET(req: NextRequest) {
  const s = getSession(req);
  if (!s) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const params = req.nextUrl?.searchParams;
  const unreadCount = countUnreadNotifications(s.user.id);
  if (params?.get("count") === "1") {
    return NextResponse.json({ unread_count: unreadCount });
  }
  const limitRaw = params?.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const notifications = listNotifications(s.user.id, {
    unreadOnly: params?.get("unread") === "1",
    limit: limit && Number.isFinite(limit) ? limit : undefined,
  });
  return NextResponse.json({ notifications, unread_count: unreadCount });
}
