import { NextRequest, NextResponse } from "next/server";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import {
  createSession,
  findUserByEmailIncludingDisabled,
  publicUser,
  setSessionCookie,
} from "@/lib/auth";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";

export const runtime = "nodejs";

const MAX_FAILS_BEFORE_LOCK = 5;
const LOCKOUT_MIN_MS = 60 * 1000; // 60s
const LOCKOUT_MAX_MS = 15 * 60 * 1000; // 15 min

type AttemptRow = {
  email: string;
  failed_count: number;
  last_failed_at: number | null;
  locked_until: number | null;
};

function readAttempt(email: string): AttemptRow | null {
  const row = db()
    .prepare(
      `SELECT email, failed_count, last_failed_at, locked_until
       FROM login_attempts WHERE email = ?`,
    )
    .get(email) as AttemptRow | undefined;
  return row ?? null;
}

function recordFailure(email: string) {
  const now = Date.now();
  const existing = readAttempt(email);
  const failedCount = (existing?.failed_count ?? 0) + 1;
  let lockedUntil: number | null = null;
  if (failedCount >= MAX_FAILS_BEFORE_LOCK) {
    const overflow = failedCount - MAX_FAILS_BEFORE_LOCK;
    const ms = Math.min(LOCKOUT_MAX_MS, LOCKOUT_MIN_MS * 2 ** overflow);
    lockedUntil = now + ms;
  }
  db()
    .prepare(
      `INSERT INTO login_attempts (email, failed_count, last_failed_at, locked_until)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         failed_count = excluded.failed_count,
         last_failed_at = excluded.last_failed_at,
         locked_until = excluded.locked_until`,
    )
    .run(email, failedCount, now, lockedUntil);
}

function clearAttempt(email: string) {
  db().prepare(`DELETE FROM login_attempts WHERE email = ?`).run(email);
}

export async function POST(req: NextRequest) {
  let body: { email?: string; password?: string };
  try {
    body = await parseBoundedJson(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password required" },
      { status: 400 },
    );
  }

  const now = Date.now();
  const attempt = readAttempt(email);
  if (attempt?.locked_until && attempt.locked_until > now) {
    const retryAfter = Math.ceil((attempt.locked_until - now) / 1000);
    const minutes = Math.max(1, Math.ceil(retryAfter / 60));
    return NextResponse.json(
      {
        error: `Too many failed attempts — try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const user = findUserByEmailIncludingDisabled(email);

  // Disabled accounts: don't leak the disabled state via timing or message —
  // return the same 401 as wrong password.
  if (!user || user.disabled_at !== null) {
    recordFailure(email);
    return NextResponse.json(
      { error: "Invalid email or password" },
      { status: 401 },
    );
  }

  if (!verifyPassword(password, user.password_hash)) {
    recordFailure(email);
    return NextResponse.json(
      { error: "Invalid email or password" },
      { status: 401 },
    );
  }

  clearAttempt(email);
  const session = createSession(user.id);
  const res = NextResponse.json({
    user: publicUser(user),
    must_change_password: !!user.must_change_password,
  });
  setSessionCookie(res, session.id);
  return res;
}
