// Auth-gated Hermes event stream for a single brief.
//
// This is intentionally under /api/briefs, not /api/share. Same-origin
// EventSource requests carry the normal session cookie; public share links
// do not get access to this route.

import { NextRequest } from "next/server";
import {
  HttpError,
  canReadBrief,
  requireUser,
} from "@/lib/auth";
import { listHermesEventsForBrief } from "@/lib/hermes/events";
import { redactSensitiveString } from "@/lib/hermes/sanitize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const POLL_MS = 1500;
const MAX_TICKS = 240; // ~6 minutes; client reconnects automatically

type Cursor = { createdAt?: number; eventId?: string };

const FORBIDDEN_KEY_RE =
  /^(authorization|cookie|set-cookie|api[_-]?key|service[_-]?token|token|tokens|password|secret|bearer|prompts?|messages?|completion|input_json|provider_error_body|headers|raw)$/i;

function stripSensitive(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redactSensitiveString(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripSensitive);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY_RE.test(k)) continue;
    out[k] = stripSensitive(v);
  }
  return out;
}

function sse(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function authResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseCursor(req: NextRequest): Cursor {
  const afterCreatedAtRaw = req.nextUrl.searchParams.get("afterCreatedAt");
  const afterEventIdRaw = req.nextUrl.searchParams.get("afterEventId");
  if (
    afterCreatedAtRaw &&
    afterEventIdRaw &&
    /^\d+$/.test(afterCreatedAtRaw)
  ) {
    return { createdAt: Number(afterCreatedAtRaw), eventId: afterEventIdRaw };
  }
  return {};
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    if (e instanceof HttpError) {
      return authResponse(e.status, String(e.body?.error || "Unauthorized"));
    }
    throw e;
  }

  if (!canReadBrief(user, params.id)) {
    return authResponse(404, "Not found");
  }

  const initial = parseCursor(req);
  let afterCreatedAt = initial.createdAt;
  let afterEventId = initial.eventId;

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(sse("ready", { ok: true }));
      let closed = false;
      req.signal.addEventListener("abort", () => {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      });

      for (let tick = 0; tick < MAX_TICKS && !closed; tick++) {
        const events = listHermesEventsForBrief(params.id, {
          limit: 50,
          afterCreatedAt,
          afterEventId,
        });
        for (const ev of events) {
          afterCreatedAt = ev.created_at;
          afterEventId = ev.id;
          controller.enqueue(
            sse("hermes-event", {
              id: ev.id,
              job_id: ev.job_id,
              seq: ev.seq,
              event_type: ev.kind,
              title: ev.title,
              summary: ev.summary,
              payload: stripSensitive(ev.payload),
              created_at: ev.created_at,
            }),
          );
        }
        controller.enqueue(sse("heartbeat", { t: Date.now() }));
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }

      if (!closed) controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
