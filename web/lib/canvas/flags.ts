// Feature flag for the read-only dynamic canvas bridge.
//
// Read via Next.js' static inlining of NEXT_PUBLIC_* env vars so this
// can be called from client components without runtime env access.
//
// IMPORTANT: this flag gates UI exposure only. It is NOT an
// authorization boundary. Do not put secrets in NEXT_PUBLIC_*.
export function isCanvasBridgeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE === "1";
}
