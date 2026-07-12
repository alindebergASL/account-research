import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { safeApplicationPath } from "../web/lib/safeApplicationPath";

const webRequire = createRequire(path.join(__dirname, "../web/package.json"));
const { NextRequest } = webRequire("next/server") as typeof import("next/server");
const { middleware } = webRequire("../web/middleware") as typeof import("../web/middleware");

test("safeApplicationPath preserves valid application-relative destinations", () => {
  for (const destination of [
    "/",
    "/brief/brief-123?view=journal&filter=open#entry-456",
    "/search?q=hello%20world#results",
    "/accounts/@team",
    "/nested//segment",
  ]) {
    assert.equal(safeApplicationPath(destination), destination);
  }
});

test("safeApplicationPath rejects cross-origin and parser-confusing destinations", () => {
  const unsafeDestinations: Array<string | null | undefined> = [
    undefined,
    null,
    "",
    "brief/brief-123",
    "https://evil.example/steal",
    "javascript:alert(1)",
    "//evil.example/steal",
    "///evil.example/steal",
    "https://user:password@evil.example/steal",
    "//user:password@evil.example/steal",
    "\\\\evil.example\\steal",
    "/\\evil.example/steal",
    "/%5cevil.example/steal",
    "/%5C%5Cevil.example/steal",
    "/%2f%2fevil.example/steal",
    " /brief/brief-123",
    "\t/brief/brief-123",
    "\n/brief/brief-123",
    "/bad%encoding",
    "/%E0%A4%A",
    "/accounts/../admin",
    "/%2e%2e/admin",
    "/safe/%2e%2e%2fadmin",
    "/unsafe path",
  ];

  for (const destination of unsafeDestinations) {
    assert.equal(
      safeApplicationPath(destination),
      "/",
      `expected ${JSON.stringify(destination)} to fall back`,
    );
  }
});

test("post-auth pages sanitize every destination before router.replace", () => {
  const loginSource = readFileSync(
    path.join(__dirname, "../web/app/login/page.tsx"),
    "utf8",
  );
  const changePasswordSource = readFileSync(
    path.join(__dirname, "../web/app/change-password/page.tsx"),
    "utf8",
  );

  assert.match(loginSource, /safeApplicationPath\(search\.get\("from"\)\)/);
  assert.match(loginSource, /router\.replace\(from\)/);
  assert.match(
    loginSource,
    /`\/change-password\?from=\$\{encodeURIComponent\(from\)\}`/,
  );
  assert.match(
    changePasswordSource,
    /safeApplicationPath\(search\.get\("from"\)\)/,
  );
  assert.match(changePasswordSource, /router\.replace\(from\)/);
});

test("middleware safely carries the protected pathname and query through login", () => {
  const request = new NextRequest(
    "https://app.example/brief/brief-123?view=journal&q=hello%20world",
  );

  const response = middleware(request);
  assert.equal(response.status, 307);
  const location = response.headers.get("location");
  assert.ok(location);

  const loginUrl = new URL(location);
  assert.equal(loginUrl.origin, "https://app.example");
  assert.equal(loginUrl.pathname, "/login");
  assert.equal(
    loginUrl.searchParams.get("from"),
    "/brief/brief-123?view=journal&q=hello%20world",
  );
});

test("middleware keeps existing public and API authorization behavior", async () => {
  const publicResponse = middleware(new NextRequest("https://app.example/login"));
  assert.equal(publicResponse.headers.get("x-middleware-next"), "1");

  const apiResponse = middleware(
    new NextRequest("https://app.example/api/briefs"),
  );
  assert.equal(apiResponse.status, 401);
  assert.deepEqual(await apiResponse.json(), { error: "Authentication required" });
});
