// Local verification for the PR-4 lab Hermes runtime service.
//
// Proves the localhost-only runtime process implements the narrow JSON
// contract consumed by lib/hermes/client.ts without model spend:
//   - /health is reachable without auth.
//   - /v1/chat requires bearer auth when HERMES_SERVICE_TOKEN is set.
//   - app client can call the service in HERMES_RUNTIME_ENABLED=1 mode.
//   - chat returns deterministic text plus a renderable Canvas for writable requests.
//   - canvas synthesis returns a renderable Canvas.
//   - research returns deterministic no-spend brief diagnostics.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

process.env.HERMES_RUNTIME_ENABLED = "1";
delete process.env.HERMES_RUNTIME_FAKE;
process.env.HERMES_SERVICE_TOKEN = "verify-runtime-token";
process.env.HERMES_RUNTIME_URL = "http://127.0.0.1:18787";
delete process.env.ANTHROPIC_API_KEY;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  runHermesChat,
  runHermesCanvasSynthesis,
  runHermesResearch,
} = require("../lib/hermes/client") as typeof import("../lib/hermes/client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Brief: BriefSchema } = require("../lib/schema") as typeof import("../lib/schema");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    // eslint-disable-next-line no-console
    console.error(`assertion failed: ${msg}`);
    process.exit(2);
  }
}

const sampleBrief = {
  account_name: "Verify Runtime Service",
  segment: "lab",
  generated_at: "1970-01-01",
  audience: "internal",
  snapshot: "Verification account snapshot.",
  priority_summary: "Verification priority summary.",
  recent_signals: [],
  ai_tech_maturity: { rating: 3, rationale: "Verification rationale." },
  top_initiatives: [],
  technical_footprint: {
    ai_in_production: [],
    active_pilots: [],
    cloud_platforms: [],
    data_infrastructure: "Verification data infrastructure.",
    clinical_platforms: "Verification platforms.",
    analytics_bi_stack: "Verification BI.",
    build_vs_buy_posture: "Verification posture.",
    competitive_incumbents: [],
  },
  programs_procurement: {
    modernization_grants: [],
    consortium_purchasing: [],
    active_rfps_contracts: [],
    ai_governance_policy: "Verification policy.",
    public_ai_use_cases: [],
  },
  personas: [],
  buying_path: "Verification buying path.",
  first_angle: "Verification first angle.",
  risks: [],
  competitive_signals: [],
  next_action: "Verification next action.",
  extensions: [],
  sources: [],
};

async function waitForHealth(baseUrl: string, child: ChildProcess): Promise<Record<string, unknown>> {
  const started = Date.now();
  let lastErr = "not attempted";
  while (Date.now() - started < 10_000) {
    if (child.exitCode !== null) throw new Error(`runtime exited early with ${child.exitCode}: ${lastErr}`);
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return (await res.json()) as Record<string, unknown>;
      lastErr = `status ${res.status}`;
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`runtime health timed out: ${lastErr}`);
}

async function main() {
  const parsed = BriefSchema.safeParse(sampleBrief);
  assert(parsed.success, "sample brief parses");

  const servicePath = path.join(process.cwd(), "scripts", "hermes-runtime-service.ts");
  const child = spawn(process.execPath, ["./node_modules/tsx/dist/cli.mjs", servicePath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HERMES_RUNTIME_BIND_HOST: "127.0.0.1",
      HERMES_RUNTIME_PORT: "18787",
      HERMES_SERVICE_TOKEN: "verify-runtime-token",
      HERMES_RUNTIME_FAKE: "1",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));

  try {
    const health = await waitForHealth(process.env.HERMES_RUNTIME_URL!, child);
    assert(health.ok === true, "health ok true");
    assert(health.bind === "127.0.0.1", "health reports loopback bind");
    assert(health.fake === true, "health reports fake/no-spend mode");

    const unauth = await fetch(`${process.env.HERMES_RUNTIME_URL}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert(unauth.status === 401, `unauthorized chat status 401, got ${unauth.status}`);

    const chat = await runHermesChat({
      job_id: "verify-runtime-chat-job",
      brief_id: "verify-runtime-brief",
      user_id: "verify-runtime-user",
      brief: parsed.data,
      history: [],
      message: "Hello localhost runtime",
      can_write: true,
    });
    assert(chat.reply.includes("[runtime fake]"), "runtime chat reply marks fake service");
    assert(Array.isArray(chat.patches_applied) && chat.patches_applied.length === 0, "runtime chat has no patches");
    assert(chat.canvas && Array.isArray(chat.canvas.widgets) && chat.canvas.widgets.length > 0, "runtime chat returns renderable canvas");
    assert(chat.events?.some((e) => e.type === "canvas.synthesis.started"), "runtime chat emits canvas event");

    const readOnly = await runHermesChat({
      job_id: "verify-runtime-readonly-job",
      brief_id: "verify-runtime-brief",
      user_id: "verify-runtime-user",
      brief: parsed.data,
      history: [],
      message: "Read-only check",
      can_write: false,
    });
    assert(readOnly.canvas === undefined, "read-only runtime chat does not return canvas");

    const canvas = await runHermesCanvasSynthesis({
      job_id: "verify-runtime-canvas-job",
      brief_id: "verify-runtime-brief",
      user_id: "verify-runtime-user",
      brief: parsed.data,
      trigger: "manual_refresh",
    });
    assert(Array.isArray(canvas.canvas.widgets) && canvas.canvas.widgets.length > 0, "canvas synthesis returns widgets");
    assert(canvas.events?.some((e) => e.type === "canvas.state.updated"), "canvas synthesis emits state event");

    const research = await runHermesResearch({
      job_id: "verify-runtime-research-job",
      user_id: "verify-runtime-user",
      intake: { account: "Verify Runtime Account", segment: "lab" },
      mode: "quick",
    });
    assert(research.brief.account_name === "Verify Runtime Account", "research returns requested account");
    assert(research.stages[0]?.provider === "runtime-fake", "research reports runtime-fake provider");
    assert(research.quality.research_attempts === 0, "research is no-spend fake mode");

    // eslint-disable-next-line no-console
    console.log(
      `hermes_runtime_service_ok health=ok auth=ok chat_canvas_widgets=${chat.canvas.widgets.length} canvas_widgets=${canvas.canvas.widgets.length} research_provider=${research.stages[0]?.provider}`,
    );
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (child.exitCode && child.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error({ stdout, stderr });
    }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    // eslint-disable-next-line no-console
    console.error("verify-hermes-runtime-service failed:", e?.message ?? e);
    process.exit(1);
  },
);
