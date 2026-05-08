import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, findUserByEmail, requireAdmin } from "@/lib/auth";
import {
  hashPassword,
  newId,
  randomTempPassword,
} from "@/lib/password";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

type AdminUserRow = {
  id: string;
  email: string;
  role: "admin" | "member" | "viewer";
  display_name: string | null;
  created_at: number;
  disabled_at: number | null;
  must_change_password: number;
  email_notifications_enabled: 0 | 1;
  brief_count: number;
};

export async function GET(req: NextRequest) {
  try {
    requireAdmin(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  const rows = db()
    .prepare(
      `SELECT u.id, u.email, u.role, u.display_name, u.created_at,
              u.disabled_at, u.must_change_password,
              u.email_notifications_enabled,
              COUNT(b.id) AS brief_count
       FROM users u
       LEFT JOIN briefs b ON b.user_id = u.id
       GROUP BY u.id
       ORDER BY u.created_at DESC`,
    )
    .all() as AdminUserRow[];
  return NextResponse.json({ users: rows });
}

export async function POST(req: NextRequest) {
  let admin;
  try {
    admin = requireAdmin(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }

  let body: {
    email?: string;
    display_name?: string;
    role?: "admin" | "member" | "viewer";
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json(
      { error: "Valid email required" },
      { status: 400 },
    );
  }
  if (findUserByEmail(email)) {
    return NextResponse.json(
      { error: "A user with that email already exists" },
      { status: 409 },
    );
  }

  const role: "admin" | "member" | "viewer" =
    body.role === "admin" ? "admin"
    : body.role === "viewer" ? "viewer"
    : "member";
  const display = (body.display_name ?? "").trim() || null;
  const tempPassword = randomTempPassword(12);
  const id = newId();
  const now = Date.now();

  db()
    .prepare(
      `INSERT INTO users
        (id, email, password_hash, role, display_name, created_at, created_by, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(id, email, hashPassword(tempPassword), role, display, now, admin.id);

  return NextResponse.json({
    user: { id, email, role, display_name: display, created_at: now },
    temp_password: tempPassword,
  });
}
