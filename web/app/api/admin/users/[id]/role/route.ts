import { NextRequest, NextResponse } from "next/server";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { db } from "@/lib/db";
import { HttpError, requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let admin;
  try {
    admin = requireAdmin(req);
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json(e.body, { status: e.status });
    }
    throw e;
  }

  let body: { role?: string };
  try {
    body = await parseBoundedJson(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const role =
    body.role === "admin" ? "admin"
    : body.role === "member" ? "member"
    : body.role === "viewer" ? "viewer"
    : null;
  if (!role) {
    return NextResponse.json(
      { error: "role must be 'admin', 'member', or 'viewer'" },
      { status: 400 },
    );
  }
  if (params.id === admin.id && role !== "admin") {
    return NextResponse.json(
      { error: "You cannot demote your own admin account" },
      { status: 400 },
    );
  }

  const now = Date.now();
  const connection = db();
  try {
    connection.transaction(() => {
      const currentAdmin = requireAdmin(req);
      if (currentAdmin.id !== admin.id) {
        throw new HttpError(403, { error: "Admin only" });
      }
      const previous = connection.prepare(`SELECT role FROM users WHERE id = ?`).get(params.id) as
        | { role: "admin" | "member" | "viewer" }
        | undefined;
      if (previous?.role === "viewer" || role === "viewer") {
        connection.prepare(
          `UPDATE brief_shares SET role = 'reader'
           WHERE user_id = ? AND role = 'editor'`,
        ).run(params.id);
      }
      connection.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, params.id);
      if (role !== "viewer") return;
      connection.prepare(
        `UPDATE briefs SET monitor_enabled = 0
         WHERE user_id = ? AND monitor_enabled <> 0`,
      ).run(params.id);
      connection.prepare(
        `UPDATE research_jobs SET status = 'cancelled', finished_at = ?
         WHERE user_id = ? AND status IN ('queued', 'running')`,
      ).run(now, params.id);
    }).immediate();
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json(e.body, { status: e.status });
    }
    throw e;
  }
  return NextResponse.json({ ok: true });
}
