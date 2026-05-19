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

export function hermesRuntimeUrl(): string {
  return process.env.HERMES_RUNTIME_URL || "http://127.0.0.1:8787";
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
