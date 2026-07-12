import type Database from "better-sqlite3";
import { NextResponse } from "next/server";
import { db } from "./db";
import { newId } from "./password";
import { assertProviderCallsEnabled, ProviderAccessDisabledError } from "./providerAccess";

export const RESEARCH_QUEUE_LIMITS = {
  activePerUser: 3,
  activeGlobal: 20,
} as const;

export type QueueIntent = "research" | "refresh" | "monitor";

export class ResearchQueueError extends Error {
  constructor(
    public readonly status: 409 | 429,
    public readonly responseBody: { error: string; jobId?: string },
  ) {
    super(responseBody.error);
    this.name = "ResearchQueueError";
  }
}

export type EnqueueResearchJobInput = {
  id?: string;
  userId: string;
  accountName: string;
  accountSegment?: string | null;
  region?: string | null;
  goal?: string | null;
  intakeJson: string;
  mode: "quick" | "standard" | "deep";
  intent?: QueueIntent;
  targetBriefId?: string | null;
  retryOfJobId?: string | null;
  now?: number;
};

function scalarCount(conn: Database.Database, sql: string, ...params: unknown[]): number {
  return (conn.prepare(sql).get(...params) as { n: number }).n;
}

export function enqueueResearchJob(input: EnqueueResearchJobInput): string {
  // Provider-backed jobs must not even enter the durable queue while disabled.
  assertProviderCallsEnabled();
  const conn = db();
  const insert = conn.transaction(() => {
    if (input.targetBriefId && (input.intent === "refresh" || input.intent === "monitor")) {
      const active = conn.prepare(
        `SELECT id FROM research_jobs
          WHERE intent = ? AND target_brief_id = ?
            AND status IN ('queued','running') LIMIT 1`,
      ).get(input.intent, input.targetBriefId) as { id: string } | undefined;
      if (active) {
        throw new ResearchQueueError(409, {
          error: input.intent === "refresh"
            ? "Refresh already queued or running"
            : "Monitor check already queued or running",
          jobId: active.id,
        });
      }
    }

    if (scalarCount(conn, `SELECT COUNT(*) AS n FROM research_jobs WHERE status IN ('queued','running')`) >= RESEARCH_QUEUE_LIMITS.activeGlobal) {
      throw new ResearchQueueError(429, { error: "Research queue is full" });
    }
    if (scalarCount(conn, `SELECT COUNT(*) AS n FROM research_jobs WHERE user_id = ? AND status IN ('queued','running')`, input.userId) >= RESEARCH_QUEUE_LIMITS.activePerUser) {
      throw new ResearchQueueError(429, { error: "Too many active research jobs" });
    }

    const id = input.id ?? newId();
    conn.prepare(
      `INSERT INTO research_jobs
        (id, user_id, account_name, account_segment, region, goal,
         intake_json, mode, status, created_at, intent, target_brief_id, retry_of_job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    ).run(
      id, input.userId, input.accountName, input.accountSegment ?? null,
      input.region ?? null, input.goal ?? null, input.intakeJson, input.mode,
      input.now ?? Date.now(), input.intent === "research" || !input.intent ? "create" : input.intent,
      input.targetBriefId ?? null, input.retryOfJobId ?? null,
    );
    return id;
  });
  return insert.immediate();
}

export function researchQueueErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof ResearchQueueError) {
    return NextResponse.json(error.responseBody, { status: error.status });
  }
  if (error instanceof ProviderAccessDisabledError) {
    return NextResponse.json(
      { error: "AI provider access is temporarily unavailable" },
      { status: 503 },
    );
  }
  return null;
}
