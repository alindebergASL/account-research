import test from "node:test";
import assert from "node:assert/strict";
import { canPreviewCanvas } from "../web/lib/canvas/capability";

const admin = {
  id: "u-admin",
  email: "admin@example.com",
  role: "admin" as const,
  display_name: "Admin",
  must_change_password: false,
};
const member = { ...admin, id: "u-member", email: "m@example.com", role: "member" as const };
const viewer = { ...admin, id: "u-viewer", email: "v@example.com", role: "viewer" as const };

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.CANVAS_PREVIEW_ENABLED;
  if (value === undefined) delete process.env.CANVAS_PREVIEW_ENABLED;
  else process.env.CANVAS_PREVIEW_ENABLED = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CANVAS_PREVIEW_ENABLED;
    else process.env.CANVAS_PREVIEW_ENABLED = prev;
  }
}

test("flag absent + admin user => canvas unavailable", () => {
  withEnv(undefined, () => {
    assert.equal(canPreviewCanvas(admin), false);
  });
});

test("flag off + admin user => canvas unavailable", () => {
  withEnv("0", () => {
    assert.equal(canPreviewCanvas(admin), false);
  });
});

test("flag on + member user => canvas unavailable", () => {
  withEnv("1", () => {
    assert.equal(canPreviewCanvas(member), false);
  });
});

test("flag on + viewer user => canvas unavailable", () => {
  withEnv("1", () => {
    assert.equal(canPreviewCanvas(viewer), false);
  });
});

test("flag on + admin user => canvas available", () => {
  withEnv("1", () => {
    assert.equal(canPreviewCanvas(admin), true);
  });
});

test("no user (public/anonymous) => canvas unavailable even with flag on", () => {
  withEnv("1", () => {
    assert.equal(canPreviewCanvas(null), false);
    assert.equal(canPreviewCanvas(undefined), false);
  });
});

// Public share routes never call canPreviewCanvas. The capability helper
// requires a PublicUser; share routes don't have one and don't construct
// one. This test documents/locks the contract that the helper returns
// false for anonymous callers — so even if someone mistakenly wired the
// helper into a share route, no preview would leak.
test("public share simulation: anonymous + flag on => canvas unavailable", () => {
  withEnv("1", () => {
    assert.equal(canPreviewCanvas(null), false);
  });
});

// Sanity: the read-only adapter is independent of capability gating.
// It can be safely called when capability is true; it must NEVER
// be called from public share render paths regardless of capability.
test("adapter still works on a representative brief (independent of gating)", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const { Brief } = require("../web/lib/schema") as typeof import("../web/lib/schema");
  const { buildReadOnlyCanvasFromBrief } = require("../web/lib/canvas/fromBrief") as typeof import("../web/lib/canvas/fromBrief");
  const sample = JSON.parse(
    readFileSync(path.join(__dirname, "sample_brief.json"), "utf8"),
  );
  const brief = Brief.parse(sample);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  assert.equal(canvas.account_name, brief.account_name);
  assert.ok(canvas.widgets.length > 0);
});
