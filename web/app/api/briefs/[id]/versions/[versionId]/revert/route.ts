import { NextRequest, NextResponse } from "next/server";
import { db, type BriefRow, type BriefVersionRow } from "@/lib/db";
import { HttpError, canManageBrief, requireUser } from "@/lib/auth";
import { Brief } from "@/lib/schema";
import { snapshotBriefVersion } from "@/lib/briefVersions";
import { logBriefReverted } from "@/lib/briefEvents";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) return NextResponse.json(e.body, { status: e.status });
  return null;
}

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ id: string; versionId: string }> }
) {
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

  const version = db()
    .prepare(`SELECT * FROM brief_versions WHERE id = ? AND brief_id = ?`)
    .get(params.versionId, params.id) as BriefVersionRow | undefined;
  if (!version) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsedVersion = Brief.safeParse(JSON.parse(version.brief_json));
  if (!parsedVersion.success) {
    return NextResponse.json({ error: "Stored version failed validation" }, { status: 500 });
  }

  const current = db().prepare(`SELECT * FROM briefs WHERE id = ?`).get(params.id) as BriefRow | undefined;
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let preRevertVersionId = "";
  const tx = db().transaction(() => {
    preRevertVersionId = snapshotBriefVersion({
      briefId: params.id,
      briefJson: current.brief_json,
      reason: "pre-revert",
      triggeredBy: user.id,
      refreshJobId: null,
    });
    const brief = parsedVersion.data;
    db()
      .prepare(
        `UPDATE briefs
         SET account_name = ?, segment = ?, audience = ?, generated_at = ?, brief_json = ?
         WHERE id = ?`,
      )
      .run(
        brief.account_name,
        brief.segment,
        brief.audience,
        brief.generated_at,
        JSON.stringify(brief),
        params.id,
      );
    if (brief.audience === "internal") {
      const now = Date.now();
      db()
        .prepare(
          `UPDATE brief_share_links
           SET revoked_at = ?
           WHERE brief_id = ?
             AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .run(now, params.id, now);
    }
  });
  tx();

  logBriefReverted({
    briefId: params.id,
    revertedFromVersionId: params.versionId,
    preRevertVersionId,
    actorUserId: user.id,
  });

  return NextResponse.json({ ok: true, brief: parsedVersion.data });
}
