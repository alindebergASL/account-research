import { NextRequest, NextResponse } from "next/server";
import {
  HttpError,
  createSession,
  deleteUserSessions,
  findUserById,
  requireUser,
  setSessionCookie,
} from "@/lib/auth";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";

export const runtime = "nodejs";

const MIN_PASSWORD_LEN = 10;

export async function POST(req: NextRequest) {
  let user;
  try {
    user = requireUser(req, { allowMustChange: true });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json(e.body, { status: e.status });
    }
    throw e;
  }

  let body: { current_password?: string; new_password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const current = body.current_password ?? "";
  const next = body.new_password ?? "";
  if (next.length < MIN_PASSWORD_LEN) {
    return NextResponse.json(
      { error: `New password must be at least ${MIN_PASSWORD_LEN} characters` },
      { status: 400 },
    );
  }

  const row = findUserById(user.id);
  if (!row) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  // Forced changes (must_change_password=1) skip the current-password check
  // because the user often only knows the temp password the admin handed them
  // and the goal is to get them off it.
  if (!row.must_change_password) {
    if (!current || !verifyPassword(current, row.password_hash)) {
      return NextResponse.json(
        { error: "Current password is incorrect" },
        { status: 401 },
      );
    }
    if (verifyPassword(next, row.password_hash)) {
      return NextResponse.json(
        { error: "New password must be different from the current one" },
        { status: 400 },
      );
    }
  }

  const newHash = hashPassword(next);
  const now = Date.now();
  db()
    .prepare(
      `UPDATE users
       SET password_hash = ?, must_change_password = 0, password_changed_at = ?
       WHERE id = ?`,
    )
    .run(newHash, now, user.id);

  // Invalidate all sessions (including the current one), then mint a fresh one
  // so the caller stays logged in but anyone else on this account is signed
  // out everywhere.
  deleteUserSessions(user.id);
  const session = createSession(user.id);
  const res = NextResponse.json({ ok: true });
  setSessionCookie(res, session.id);
  return res;
}
