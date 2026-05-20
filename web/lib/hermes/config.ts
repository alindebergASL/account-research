// Hermes runtime config helpers.
//
// All readers are pure functions over process.env. There are NO side
// effects at import time: callers must invoke the helpers at request /
// job time so flag flips do not require a module reload.
//
// All flags default OFF. Live model calls and any non-localhost HTTP
// will only happen when an operator explicitly opts in.

export type HermesRuntimeMode = "direct" | "fake" | "hermes";

export function hermesRuntimeMode(): HermesRuntimeMode {
  if (process.env.HERMES_RUNTIME_FAKE === "1") return "fake";
  if (process.env.HERMES_RUNTIME_ENABLED === "1") return "hermes";
  return "direct";
}

export function hermesRuntimeEnabled(): boolean {
  return process.env.HERMES_RUNTIME_ENABLED === "1";
}

export function hermesRuntimeFake(): boolean {
  return process.env.HERMES_RUNTIME_FAKE === "1";
}

// Hosts allowed for the runtime URL. The runtime is an internal,
// localhost-only service; non-loopback values are operator error and
// must be rejected before any HTTP call escapes the box.
const LOOPBACK_HOSTS = new Set<string>(["127.0.0.1", "::1", "localhost"]);

/**
 * Returns true iff `urlStr` parses as a URL whose host is one of
 * `127.0.0.1`, `::1`, or `localhost`. Parse failures are treated as
 * NOT loopback.
 */
export function isLoopbackUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    // `URL` returns "[::1]" for bracketed IPv6 hostnames; normalize.
    const host = u.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    return LOOPBACK_HOSTS.has(host);
  } catch {
    return false;
  }
}

export class HermesRuntimeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesRuntimeUrlError";
  }
}

/** Raw configured runtime URL. No validation. */
export function getHermesRuntimeUrl(): string {
  return process.env.HERMES_RUNTIME_URL || "http://127.0.0.1:8787";
}

/**
 * Loopback-checked runtime URL. Throws `HermesRuntimeUrlError` when
 * the configured URL is not on `127.0.0.1`, `::1`, or `localhost`.
 * The error message is a fixed string — no env value is interpolated
 * — so a misconfigured URL cannot leak into a log via this path.
 */
export function getHermesRuntimeUrlChecked(): string {
  const url = getHermesRuntimeUrl();
  if (!isLoopbackUrl(url)) {
    throw new HermesRuntimeUrlError(
      "HERMES_RUNTIME_URL must be loopback (127.0.0.1, ::1, or localhost); refusing to send runtime request",
    );
  }
  return url;
}

/** @deprecated use `getHermesRuntimeUrl` or `getHermesRuntimeUrlChecked`. */
export function hermesRuntimeUrl(): string {
  return getHermesRuntimeUrl();
}

export function hermesServiceToken(): string | null {
  const v = process.env.HERMES_SERVICE_TOKEN;
  return v && v.length > 0 ? v : null;
}

export function hermesResearchEnabled(): boolean {
  return process.env.HERMES_RESEARCH_ENABLED === "1";
}

export function hermesChatEnabled(): boolean {
  return process.env.HERMES_CHAT_ENABLED === "1";
}

export function hermesCanvasEventsEnabled(): boolean {
  return process.env.HERMES_CANVAS_EVENTS_ENABLED === "1";
}

export function hermesCanvasProposalsEnabled(): boolean {
  return process.env.HERMES_CANVAS_PROPOSALS_ENABLED === "1";
}

export function hermesCanvasLayoutFreeformEnabled(): boolean {
  return process.env.HERMES_CANVAS_LAYOUT_FREEFORM === "1";
}

export function hermesGenerativeCanvasEnabled(): boolean {
  return hermesRuntimeEnabled() && hermesCanvasProposalsEnabled();
}
