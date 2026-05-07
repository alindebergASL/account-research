import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
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
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const role = body.role === "admin" ? "admin" : body.role === "member" ? "member" : null;
  if (!role) {
    return NextResponse.json(
      { error: "role must be 'admin' or 'member'" },
      { status: 400 },
    );
  }
  if (params.id === admin.id && role !== "admin") {
    return NextResponse.json(
      { error: "You cannot demote your own admin account" },
      { status: 400 },
    );
  }

  db()
    .prepare(`UPDATE users SET role = ? WHERE id = ?`)
    .run(role, params.id);
  return NextResponse.json({ ok: true });
}
