import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

// PATCH /api/admin/users/[id]/notifications — admin-only.
// Body: { email_notifications_enabled: boolean }
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireAdmin(req);
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json(e.body, { status: e.status });
    }
    throw e;
  }

  let body: { email_notifications_enabled?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.email_notifications_enabled !== "boolean") {
    return NextResponse.json(
      { error: "email_notifications_enabled must be boolean" },
      { status: 400 },
    );
  }

  const target = db()
    .prepare(`SELECT id FROM users WHERE id = ?`)
    .get(params.id);
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  db()
    .prepare(`UPDATE users SET email_notifications_enabled = ? WHERE id = ?`)
    .run(body.email_notifications_enabled ? 1 : 0, params.id);
  return NextResponse.json({ ok: true });
}
