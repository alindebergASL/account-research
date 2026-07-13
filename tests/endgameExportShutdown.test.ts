import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const privateExport = require("../web/app/api/export/route") as typeof import("../web/app/api/export/route");
const publicExport = require("../web/app/api/share/[token]/export/route") as typeof import("../web/app/api/share/[token]/export/route");

const root = path.resolve(import.meta.dirname, "..");
const privateRoutePath = path.join(root, "web/app/api/export/route.ts");
const publicRoutePath = path.join(
  root,
  "web/app/api/share/[token]/export/route.ts",
);
const briefCanvasPath = path.join(root, "web/components/BriefCanvas.tsx");
const publicPagePath = path.join(root, "web/app/s/[token]/page.tsx");

const fixedBody = JSON.stringify({ error: "Not found" });

async function assertFixedNotFound(response: Response) {
  assert.equal(response.status, 404);
  assert.equal(await response.text(), fixedBody);
}

function hostile(label: string, touches: string[]) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        touches.push(`${label}.${String(property)}`);
        throw new Error(`${label} must not be inspected`);
      },
    },
  );
}

test("private export is a uniform fixed 404 before request parsing or caller inspection", async () => {
  for (const input of [undefined, null, {}, "hostile", new Uint8Array([1, 2, 3])]) {
    await assertFixedNotFound(await privateExport.POST(input as never));
  }

  const touches: string[] = [];
  await assertFixedNotFound(
    await privateExport.POST(hostile("request", touches) as never),
  );
  assert.deepEqual(touches, []);
});

test("public export is the same uniform fixed 404 without reading request or params", async () => {
  const inputs = [
    [undefined, undefined],
    [null, null],
    [{}, {}],
    [
      "hostile",
      {
        params: {
          then() {
            throw new Error("must not await params");
          },
        },
      },
    ],
  ] as const;

  for (const [request, props] of inputs) {
    await assertFixedNotFound(
      await publicExport.GET(request as never, props as never),
    );
  }

  const touches: string[] = [];
  await assertFixedNotFound(
    await publicExport.GET(
      hostile("request", touches) as never,
      hostile("props", touches) as never,
    ),
  );
  assert.deepEqual(touches, []);
});

test("export route sources cannot parse, authorize, read, or render", () => {
  const privateSource = readFileSync(privateRoutePath, "utf8");
  const publicSource = readFileSync(publicRoutePath, "utf8");
  const forbidden = [
    /req(?:uest)?\.json\s*\(/,
    /cookies?\b/,
    /requireUser|session|authorize|auth\b/i,
    /\bdb\s*\(|database|sqlite/i,
    /object.?storage|\bs3\b/i,
    /from\s+["'](?:node:)?fs(?:\/promises)?["']|\bfs\./,
    /child_process|\bspawn\s*\(|\bexec(?:File)?\s*\(/,
    /generate_brief|runRenderer|render(?:er)?\s*\(/i,
    /Brief\.safeParse/,
    /await\s+[^;]*(?:params|json)/,
  ];

  for (const [name, source] of [
    ["private", privateSource],
    ["public", publicSource],
  ] as const) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${name} route matched ${pattern}`);
    }
  }
});

test("Brief UI exposes no export call site or active export controls", () => {
  const canvas = readFileSync(briefCanvasPath, "utf8");
  const publicPage = readFileSync(publicPagePath, "utf8");

  assert.match(canvas, /Brief export is currently unavailable\./);
  assert.doesNotMatch(canvas, /\/api\/export/);
  assert.doesNotMatch(canvas, /\/export\?format=/);
  assert.doesNotMatch(canvas, /DownloadBar|download\s*\(/i);
  assert.doesNotMatch(canvas, /Download (?:PDF|DOCX)/i);
  assert.doesNotMatch(canvas, /type=["']button["'][\s\S]{0,300}(?:export|download)/i);
  assert.doesNotMatch(publicPage, /publicToken=/);
});
