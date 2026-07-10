import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  HttpError,
  deleteUserSessions,
  requireAdmin,
} from "@/lib/auth";
import { hashPassword, randomTempPassword } from "@/lib/password";

export const runtime = "nodejs";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireAdmin(req);
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json(e.body, { status: e.status });
    }
    throw e;
  }

  const target = db()
    .prepare(`SELECT email FROM users WHERE id = ?`)
    .get(params.id) as { email: string } | undefined;
  if (!target) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const tempPassword = randomTempPassword(12);
  db()
    .prepare(
      `UPDATE users
       SET password_hash = ?, must_change_password = 1, password_changed_at = ?
       WHERE id = ?`,
    )
    .run(hashPassword(tempPassword), Date.now(), params.id);
  deleteUserSessions(params.id);

  // Also clear any login lock so the user can immediately try the new temp.
  db()
    .prepare(`DELETE FROM login_attempts WHERE email = ?`)
    .run(target.email);

  return NextResponse.json({
    email: target.email,
    temp_password: tempPassword,
  });
}
