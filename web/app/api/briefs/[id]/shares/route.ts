import { NextRequest, NextResponse } from "next/server";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { db } from "@/lib/db";
import {
  HttpError,
  canManageBrief,
  findUserByEmail,
  requireUser,
} from "@/lib/auth";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

type ShareListRow = {
  user_id: string;
  email: string;
  granted_by_email: string;
  created_at: number;
  role: "reader" | "editor";
};

function normalizeRole(input: unknown): "reader" | "editor" {
  // Accept legacy 'viewer' from clients defensively (translate to 'reader').
  return input === "editor" ? "editor" : "reader";
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (!canManageBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const rows = db()
    .prepare(
      `SELECT s.user_id, u.email, granter.email AS granted_by_email,
              s.created_at, s.role
       FROM brief_shares s
       JOIN users u ON u.id = s.user_id
       JOIN users granter ON granter.id = s.granted_by
       WHERE s.brief_id = ?
       ORDER BY s.created_at ASC`,
    )
    .all(params.id) as ShareListRow[];
  return NextResponse.json({ shares: rows });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (!canManageBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  let body: { email?: string; role?: string };
  try {
    body = await parseBoundedJson(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const email = (body.email ?? "").trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }
  const role = normalizeRole(body.role);

  const outcome = db().transaction(() => {
    const target = findUserByEmail(email);
    if (!target) return { kind: "target_not_found" } as const;
    if (role === "editor" && target.role === "viewer") {
      return { kind: "viewer_editor" } as const;
    }

    // Don't share with yourself or the owner.
    const owner = db()
      .prepare(`SELECT user_id FROM briefs WHERE id = ?`)
      .get(params.id) as { user_id: string } | undefined;
    if (!owner) return { kind: "brief_not_found" } as const;
    if (target.id === owner.user_id) return { kind: "owner" } as const;

    // Insert the share if absent; if it already exists, update the role so the
    // caller's request reflects on the existing row (matches the dialog's
    // "share at editor" expectation when the user is already a reader).
    db()
      .prepare(
        `INSERT INTO brief_shares (brief_id, user_id, granted_by, created_at, role)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(brief_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(params.id, target.id, user.id, Date.now(), role);

    return { kind: "shared", target } as const;
  }).immediate();

  if (outcome.kind === "target_not_found") {
    return NextResponse.json(
      { error: "No user with that email — ask an admin to create one" },
      { status: 404 },
    );
  }
  if (outcome.kind === "viewer_editor") {
    return NextResponse.json(
      { error: "Viewer accounts can only receive reader access" },
      { status: 403 },
    );
  }
  if (outcome.kind === "brief_not_found") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (outcome.kind === "owner") {
    return NextResponse.json(
      { error: "That user already owns this brief" },
      { status: 400 },
    );
  }

  return NextResponse.json({
    share: {
      user_id: outcome.target.id,
      email: outcome.target.email,
      granted_by_email: user.email,
      role,
    },
  });
}
