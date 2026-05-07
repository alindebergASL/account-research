import type { NextRequest, NextResponse } from "next/server";
import { db, type UserRow, type SessionRow } from "./db";
import { randomSessionId } from "./password";

export const SESSION_COOKIE = "abb_session";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // refresh when <7d left

export type PublicUser = {
  id: string;
  email: string;
  role: "admin" | "member";
  display_name: string | null;
};

export type SessionInfo = {
  user: PublicUser;
  session: SessionRow;
};

export function publicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    display_name: row.display_name,
  };
}

export function findUserByEmail(email: string): UserRow | null {
  const row = db()
    .prepare(
      `SELECT * FROM users WHERE email = ? COLLATE NOCASE`,
    )
    .get(email.trim().toLowerCase()) as UserRow | undefined;
  return row ?? null;
}

export function findUserById(id: string): UserRow | null {
  const row = db()
    .prepare(`SELECT * FROM users WHERE id = ?`)
    .get(id) as UserRow | undefined;
  return row ?? null;
}

export function createSession(userId: string): SessionRow {
  const id = randomSessionId();
  const now = Date.now();
  const expires = now + SESSION_TTL_MS;
  db()
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, userId, now, expires);
  return { id, user_id: userId, created_at: now, expires_at: expires };
}

export function deleteSession(sessionId: string) {
  db().prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
}

export function deleteUserSessions(userId: string) {
  db().prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
}

export function getSession(req: NextRequest): SessionInfo | null {
  const id = req.cookies.get(SESSION_COOKIE)?.value;
  if (!id) return null;
  const session = db()
    .prepare(`SELECT * FROM sessions WHERE id = ?`)
    .get(id) as SessionRow | undefined;
  if (!session) return null;

  const now = Date.now();
  if (session.expires_at < now) {
    deleteSession(id);
    return null;
  }

  const user = findUserById(session.user_id);
  if (!user) {
    deleteSession(id);
    return null;
  }

  // Sliding refresh: when within 7 days of expiry, push expiry forward.
  if (session.expires_at - now < SESSION_REFRESH_WINDOW_MS) {
    const newExpiry = now + SESSION_TTL_MS;
    db()
      .prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`)
      .run(newExpiry, id);
    session.expires_at = newExpiry;
  }

  return { user: publicUser(user), session };
}

export function setSessionCookie(res: NextResponse, sessionId: string) {
  res.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: process.env.NODE_ENV === "production",
  });
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    secure: process.env.NODE_ENV === "production",
  });
}

// Throws a Response that route handlers can `throw` (or use via try/catch).
export class HttpError extends Error {
  constructor(public status: number, public body: any) {
    super(typeof body === "string" ? body : body?.error || "HTTP error");
  }
}

export function requireUser(req: NextRequest): PublicUser {
  const s = getSession(req);
  if (!s) throw new HttpError(401, { error: "Authentication required" });
  return s.user;
}

export function requireAdmin(req: NextRequest): PublicUser {
  const user = requireUser(req);
  if (user.role !== "admin") {
    throw new HttpError(403, { error: "Admin only" });
  }
  return user;
}

// ---- brief authorization ---------------------------------------------------

export function getBriefOwner(briefId: string): string | null {
  const row = db()
    .prepare(`SELECT user_id FROM briefs WHERE id = ?`)
    .get(briefId) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

export function isSharedWith(briefId: string, userId: string): boolean {
  const row = db()
    .prepare(
      `SELECT 1 AS x FROM brief_shares WHERE brief_id = ? AND user_id = ?`,
    )
    .get(briefId, userId) as { x: number } | undefined;
  return !!row;
}

export function canReadBrief(user: PublicUser, briefId: string): boolean {
  const owner = getBriefOwner(briefId);
  if (!owner) return false;
  if (owner === user.id) return true;
  if (user.role === "admin") return true;
  return isSharedWith(briefId, user.id);
}

export function canWriteBrief(user: PublicUser, briefId: string): boolean {
  const owner = getBriefOwner(briefId);
  if (!owner) return false;
  if (owner === user.id) return true;
  if (user.role === "admin") return true;
  return false;
}
