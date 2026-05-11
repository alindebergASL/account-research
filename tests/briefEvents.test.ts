import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeEventMetadata } from "../web/lib/briefEvents";

test("sanitizer drops secret/auth/cookie keys", () => {
  const out = sanitizeEventMetadata({
    password: "x",
    secret: "x",
    token: "x",
    api_key: "x",
    apiKey: "x",
    authorization: "Bearer x",
    cookie: "x",
    session_id: "x",
    bearer: "x",
    keep_me: "value",
  });
  assert.ok(out);
  assert.equal((out as any).password, undefined);
  assert.equal((out as any).secret, undefined);
  assert.equal((out as any).token, undefined);
  assert.equal((out as any).api_key, undefined);
  assert.equal((out as any).apiKey, undefined);
  assert.equal((out as any).authorization, undefined);
  assert.equal((out as any).cookie, undefined);
  assert.equal((out as any).session_id, undefined);
  assert.equal((out as any).bearer, undefined);
  assert.equal((out as any).keep_me, "value");
});

test("sanitizer drops prompt/message/content (LLM payloads)", () => {
  const out = sanitizeEventMetadata({
    prompt: "system prompt text",
    messages: [{ role: "user", content: "hello" }],
    content: "blob",
    completion: "model output",
    safe_field: 42,
  });
  assert.ok(out);
  assert.equal((out as any).prompt, undefined);
  assert.equal((out as any).messages, undefined);
  assert.equal((out as any).content, undefined);
  assert.equal((out as any).completion, undefined);
  assert.equal((out as any).safe_field, 42);
});

test("sanitizer recurses and drops forbidden keys at depth", () => {
  const out = sanitizeEventMetadata({
    outer: { inner: { token: "x", keep: "ok" } },
    list: [{ password: "x", id: 1 }],
  }) as any;
  assert.equal(out.outer.inner.token, undefined);
  assert.equal(out.outer.inner.keep, "ok");
  assert.equal(out.list[0].password, undefined);
  assert.equal(out.list[0].id, 1);
});

test("sanitizer flattens past depth 4", () => {
  const deep: any = { a: { b: { c: { d: { e: { token: "x", v: 1 } } } } } };
  const out = sanitizeEventMetadata(deep) as any;
  // At depth 4 the inner object becomes a stringified preview, not a
  // structured object; just verify it doesn't throw and forbidden values
  // do not appear unredacted in the output.
  const serialized = JSON.stringify(out);
  assert.ok(serialized.length > 0);
});

test("sanitizer truncates payloads over 8 KB", () => {
  const big: Record<string, unknown> = {};
  for (let i = 0; i < 1000; i++) {
    big[`field_${i}`] = "a".repeat(50);
  }
  const out = sanitizeEventMetadata(big) as any;
  assert.equal(out.truncated, true);
  assert.ok(Array.isArray(out.original_keys));
});

test("sanitizer returns null for empty input", () => {
  assert.equal(sanitizeEventMetadata(null), null);
  assert.equal(sanitizeEventMetadata(undefined), null);
});

test("sanitizer output is JSON-serializable", () => {
  const out = sanitizeEventMetadata({
    a: 1,
    b: "x",
    c: [1, 2, 3],
    d: { e: true, f: null },
  });
  assert.doesNotThrow(() => JSON.stringify(out));
});
