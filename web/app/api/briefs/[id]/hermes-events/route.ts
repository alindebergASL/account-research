// Internal Hermes event read API.
//
// AUTH-GATED. This is NOT a public share endpoint. Public share routes
// (`web/app/s/**`, `web/app/api/share/**`) MUST NOT call this route and
// MUST NOT import these helpers — verified by grep in CI.
//
// Returns a sanitized projection of `hermes_job_events` for one brief.
// We re-sanitize on read even though writes also sanitize, because the
// at-rest payload might predate a future sanitizer tightening, and we
// never want a leaked-secret regression to escape the DB perimeter.
import { NextRequest, NextResponse } from "next/server";
import {
  HttpError,
  canReadBrief,
  requireUser,
} from "@/lib/auth";
import { listHermesEventsForBrief, MAX_EVENT_LIMIT } from "@/lib/hermes/events";

export const runtime = "nodejs";

// Allow-list of payload keys we ever return. Anything else is dropped,
// regardless of how it got into payload_json. Keep this list narrow.
const ALLOWED_PAYLOAD_KEYS = new Set<string>([
  "widget_kind",
  "widget_id",
  "section",
  "trigger",
  "mode",
  "stage",
  "source_count",
  "claim_count",
  "patch_count",
  "duration_ms",
  "version",
  "fake",
  "kind",
  "status",
]);

const FORBIDDEN_KEY_RE =
  /^(authorization|cookie|set-cookie|api[_-]?key|service[_-]?token|token|tokens|password|secret|bearer|prompts?|messages?|completion|input_json|provider_error_body|headers|raw)$/i;

function stripSensitive(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripSensitive);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY_RE.test(k)) continue;
    if (!ALLOWED_PAYLOAD_KEYS.has(k)) continue;
    out[k] = stripSensitive(v);
  }
  return out;
}

function authError(e: unknown): NextResponse | null {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }

  if (!canReadBrief(user, params.id)) {
    // Match existing brief routes: 404 (not 403) so we don't leak the
    // existence of briefs the caller can't read.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const afterRaw = req.nextUrl.searchParams.get("after");
  const afterSeq = afterRaw && /^\d+$/.test(afterRaw) ? Number(afterRaw) : undefined;
  const limitRaw = req.nextUrl.searchParams.get("limit");
  const limit = limitRaw && /^\d+$/.test(limitRaw) ? Math.min(Number(limitRaw), MAX_EVENT_LIMIT) : MAX_EVENT_LIMIT;

  const events = listHermesEventsForBrief(params.id, { limit, afterSeq });

  const safe = events.map((e) => ({
    id: e.id,
    job_id: e.job_id,
    seq: e.seq,
    event_type: e.kind,
    title: e.title,
    summary: e.summary,
    payload: stripSensitive(e.payload),
    created_at: e.created_at,
  }));

  return NextResponse.json({ events: safe });
}
