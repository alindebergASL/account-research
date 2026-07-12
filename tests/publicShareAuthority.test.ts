import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(os.tmpdir(), "public-share-authority-"));
process.env.BRIEF_DB_PATH = path.join(tmp, "test.sqlite");
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "Password123!";
process.env.SMTP_HOST = "smtp.example.com";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "user";
process.env.SMTP_PASS = "pass";
process.env.MAIL_FROM = "sender@example.com";

test.after(() => rmSync(tmp, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const { db, initDb } = require("../web/lib/db") as typeof import("../web/lib/db");
const auth = require("../web/lib/auth") as typeof import("../web/lib/auth");
const email = require("../web/lib/email") as typeof import("../web/lib/email");
const publicRoute = require("../web/app/api/share/[token]/route") as typeof import("../web/app/api/share/[token]/route");
const commentsRoute = require("../web/app/api/share/[token]/comments/route") as typeof import("../web/app/api/share/[token]/comments/route");
const exportRoute = require("../web/app/api/share/[token]/export/route") as typeof import("../web/app/api/share/[token]/export/route");
const briefRoute = require("../web/app/api/briefs/[id]/route") as typeof import("../web/app/api/briefs/[id]/route");
const linksRoute = require("../web/app/api/briefs/[id]/share-links/route") as typeof import("../web/app/api/briefs/[id]/share-links/route");
const emailRoute = require("../web/app/api/briefs/[id]/share-links/[linkId]/email/route") as typeof import("../web/app/api/briefs/[id]/share-links/[linkId]/email/route");
const revertRoute = require("../web/app/api/briefs/[id]/versions/[versionId]/revert/route") as typeof import("../web/app/api/briefs/[id]/versions/[versionId]/revert/route");

initDb();

function briefJson(audience: "internal" | "shareable") {
  return {
    account_name: "Acme",
    segment: "Healthcare",
    audience,
    generated_at: new Date().toISOString(),
    snapshot: "Customer-safe snapshot",
    priority_summary: "Priority",
    recent_signals: [],
    ai_tech_maturity: { rating: 3, rationale: "r" },
    top_initiatives: [],
    technical_footprint: {
      ai_in_production: [], active_pilots: [], cloud_platforms: [],
      data_infrastructure: "", clinical_platforms: "", analytics_bi_stack: "",
      build_vs_buy_posture: "", competitive_incumbents: [],
    },
    programs_procurement: {
      modernization_grants: [], consortium_purchasing: [],
      active_rfps_contracts: [], ai_governance_policy: "", public_ai_use_cases: [],
    },
    personas: [], buying_path: "", first_angle: "", risks: [],
    competitive_signals: [], next_action: "Internal next action", extensions: [], sources: [],
  };
}

function seedBrief(id: string, audience: "internal" | "shareable" = "shareable") {
  const json = briefJson(audience);
  db().prepare(`INSERT INTO briefs
    (id,user_id,account_name,segment,audience,generated_at,created_at,brief_json)
    VALUES (?, 'owner', 'Acme', 'Healthcare', ?, ?, ?, ?)`)
    .run(id, audience, json.generated_at, Date.now(), JSON.stringify(json));
}

function seedLink(id: string, briefId: string, token: string, options: {
  expiresAt?: number | null; revokedAt?: number | null; accessCount?: number;
} = {}) {
  db().prepare(`INSERT INTO brief_share_links
    (id,brief_id,token,created_by,created_at,expires_at,revoked_at,last_accessed_at,access_count)
    VALUES (?, ?, ?, 'owner', ?, ?, ?, NULL, ?)`)
    .run(id, briefId, token, Date.now(), options.expiresAt ?? null,
      options.revokedAt ?? null, options.accessCount ?? 0);
}

function req(sessionId?: string, body?: unknown): any {
  return {
    url: "http://localhost/api/test",
    cookies: { get: (name: string) => sessionId && name === auth.SESSION_COOKIE ? { value: sessionId } : undefined },
    async json() {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  };
}

async function payload(response: Response) {
  return response.json() as Promise<any>;
}

db().prepare(`INSERT INTO users
  (id,email,password_hash,role,display_name,created_at,must_change_password)
  VALUES ('owner','owner@example.com','h','member','Owner',?,0)`).run(Date.now());
const ownerSession = auth.createSession("owner").id;

seedBrief("shareable", "shareable");
seedBrief("internal", "internal");
seedLink("live", "shareable", "live-token", { accessCount: 4 });
seedLink("internal-live", "internal", "internal-token", { accessCount: 7 });
seedLink("expired", "shareable", "expired-token", { expiresAt: Date.now() - 1, accessCount: 9 });
seedLink("revoked", "shareable", "revoked-token", { revokedAt: Date.now() - 1, accessCount: 11 });

test("public GET requires a live token and the owning brief's current shareable audience", async () => {
  const allowed = await publicRoute.GET(req(), { params: Promise.resolve({ token: "live-token" }) });
  assert.equal(allowed.status, 200);
  assert.equal((await payload(allowed)).brief.next_action, "");
  assert.equal((db().prepare(`SELECT access_count FROM brief_share_links WHERE id = 'live'`).get() as any).access_count, 5);

  for (const token of ["internal-token", "expired-token", "revoked-token", "missing-token"]) {
    const denied = await publicRoute.GET(req(), { params: Promise.resolve({ token }) });
    assert.equal(denied.status, 404);
    assert.deepEqual(await payload(denied), { error: "Not found" });
  }
  assert.equal((db().prepare(`SELECT access_count FROM brief_share_links WHERE id = 'internal-live'`).get() as any).access_count, 7);
  assert.equal((db().prepare(`SELECT access_count FROM brief_share_links WHERE id = 'expired'`).get() as any).access_count, 9);
  assert.equal((db().prepare(`SELECT access_count FROM brief_share_links WHERE id = 'revoked'`).get() as any).access_count, 11);

  db().prepare(`UPDATE briefs SET audience = 'internal' WHERE id = 'shareable'`).run();
  const reversed = await publicRoute.GET(req(), { params: Promise.resolve({ token: "live-token" }) });
  assert.equal(reversed.status, 404);
  assert.deepEqual(await payload(reversed), { error: "Not found" });
  assert.equal((db().prepare(`SELECT access_count FROM brief_share_links WHERE id = 'live'`).get() as any).access_count, 5);
  db().prepare(`UPDATE briefs SET audience = 'shareable' WHERE id = 'shareable'`).run();
});

test("public comments and export are fixed uniform 404s with no internal exposure", async () => {
  db().prepare(`INSERT INTO brief_comments
    (id,brief_id,user_id,parent_id,body,ai_assisted,created_at,edited_at,deleted_at)
    VALUES ('secret-comment','shareable','owner',NULL,'internal body',0,?,NULL,NULL)`).run(Date.now());

  for (const route of [commentsRoute, exportRoute]) {
    for (const token of ["live-token", "internal-token", "missing-token"]) {
      const response = await route.GET(req(), { params: Promise.resolve({ token }) } as any);
      assert.equal(response.status, 404);
      const raw = JSON.stringify(await payload(response));
      assert.equal(raw, JSON.stringify({ error: "Not found" }));
      assert.equal(raw.includes("internal body"), false);
      assert.equal(raw.includes("owner@example.com"), false);
    }
  }
});

test("internal audience PATCH revokes every live public link atomically", async () => {
  seedBrief("patch-target");
  seedLink("patch-a", "patch-target", "patch-a");
  seedLink("patch-b", "patch-target", "patch-b", { expiresAt: Date.now() - 1000 });
  const response = await briefRoute.PATCH(req(ownerSession, { audience: "internal" }), {
    params: Promise.resolve({ id: "patch-target" }),
  });
  assert.equal(response.status, 200);
  const row = db().prepare(`SELECT audience, brief_json FROM briefs WHERE id = 'patch-target'`).get() as any;
  assert.equal(row.audience, "internal");
  assert.equal(JSON.parse(row.brief_json).audience, "internal");
  assert.notEqual((db().prepare(`SELECT revoked_at FROM brief_share_links WHERE id = 'patch-a'`).get() as any).revoked_at, null);
  assert.equal((db().prepare(`SELECT revoked_at FROM brief_share_links WHERE id = 'patch-b'`).get() as any).revoked_at, null);
});

test("audience PATCH rolls back the brief update when link revocation fails", async () => {
  seedBrief("rollback-target");
  seedLink("rollback-link", "rollback-target", "rollback-token");
  db().exec(`CREATE TRIGGER fail_rollback_revoke BEFORE UPDATE OF revoked_at ON brief_share_links
    WHEN OLD.brief_id = 'rollback-target' BEGIN SELECT RAISE(ABORT, 'forced revoke failure'); END`);
  await assert.rejects(() => briefRoute.PATCH(req(ownerSession, { audience: "internal" }), {
    params: Promise.resolve({ id: "rollback-target" }),
  }), /forced revoke failure/);
  db().exec(`DROP TRIGGER fail_rollback_revoke`);
  const row = db().prepare(`SELECT audience, brief_json FROM briefs WHERE id = 'rollback-target'`).get() as any;
  assert.equal(row.audience, "shareable");
  assert.equal(JSON.parse(row.brief_json).audience, "shareable");
  assert.equal((db().prepare(`SELECT revoked_at FROM brief_share_links WHERE id = 'rollback-link'`).get() as any).revoked_at, null);
});

test("reverting to an internal version revokes live links in the revert transaction", async () => {
  seedBrief("revert-target");
  seedLink("revert-link", "revert-target", "revert-token");
  db().prepare(`INSERT INTO brief_versions
    (id,brief_id,version_no,brief_json,reason,triggered_by,refresh_job_id,created_at)
    VALUES ('internal-version','revert-target',1,?,'test','owner',NULL,?)`)
    .run(JSON.stringify(briefJson("internal")), Date.now());
  const response = await revertRoute.POST(req(ownerSession), {
    params: Promise.resolve({ id: "revert-target", versionId: "internal-version" }),
  });
  assert.equal(response.status, 200);
  assert.equal((db().prepare(`SELECT audience FROM briefs WHERE id = 'revert-target'`).get() as any).audience, "internal");
  assert.notEqual((db().prepare(`SELECT revoked_at FROM brief_share_links WHERE id = 'revert-link'`).get() as any).revoked_at, null);
});

test("share-link list/create and email refuse an audience-ineligible capability before side effects", async () => {
  const allowedList = await linksRoute.GET(req(ownerSession), { params: Promise.resolve({ id: "shareable" }) });
  assert.equal(allowedList.status, 200);
  const allowedCreate = await linksRoute.POST(req(ownerSession, { ttl: "24h" }), { params: Promise.resolve({ id: "shareable" }) });
  assert.equal(allowedCreate.status, 200);

  const list = await linksRoute.GET(req(ownerSession), { params: Promise.resolve({ id: "internal" }) });
  assert.equal(list.status, 409);

  const create = await linksRoute.POST(req(ownerSession, { ttl: "24h" }), { params: Promise.resolve({ id: "internal" }) });
  assert.equal(create.status, 409);

  let sends = 0;
  email.__setTestMailer(async () => { sends += 1; });
  try {
    const before = (db().prepare(`SELECT COUNT(*) AS n FROM brief_share_emails`).get() as any).n;
    const allowedEmail = await emailRoute.POST(req(ownerSession, { recipient: "allowed@example.com" }), {
      params: Promise.resolve({ id: "shareable", linkId: "live" }),
    });
    assert.equal(allowedEmail.status, 200);
    assert.equal(sends, 1);
    assert.equal((db().prepare(`SELECT COUNT(*) AS n FROM brief_share_emails`).get() as any).n, before + 1);

    const response = await emailRoute.POST(req(ownerSession, { recipient: "customer@example.com" }), {
      params: Promise.resolve({ id: "internal", linkId: "internal-live" }),
    });
    assert.equal(response.status, 409);
    assert.equal(sends, 1);
    assert.equal((db().prepare(`SELECT COUNT(*) AS n FROM brief_share_emails`).get() as any).n, before + 1);
  } finally {
    email.__setTestMailer(null);
  }
});

test("the public page does not mount or reference a public comments client", () => {
  const source = readFileSync(path.join(__dirname, "../web/app/s/[token]/page.tsx"), "utf8");
  assert.doesNotMatch(source, /PublicCommentsSection|\/comments/);
});
