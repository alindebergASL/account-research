import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let admin;
  try {
    admin = requireAdmin(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }

  if (params.id === admin.id) {
    return NextResponse.json(
      { error: "You cannot delete your own account" },
      { status: 400 },
    );
  }

  const target = db()
    .prepare(`SELECT id FROM users WHERE id = ?`)
    .get(params.id) as { id: string } | undefined;
  if (!target) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const conn = db();
  const tx = conn.transaction(() => {
    // Reassign owned content to the deleting admin so work isn't lost.
    conn
      .prepare(`UPDATE briefs SET user_id = ? WHERE user_id = ?`)
      .run(admin.id, params.id);
    conn
      .prepare(`UPDATE brief_chats SET user_id = ? WHERE user_id = ?`)
      .run(admin.id, params.id);
    // Delete the user — sessions and brief_shares cascade via FK.
    conn.prepare(`DELETE FROM users WHERE id = ?`).run(params.id);
  });
  tx();

  return NextResponse.json({ ok: true });
}
