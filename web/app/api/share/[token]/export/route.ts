import { exportNotFoundResponse } from "@/lib/exportShutdown";

export const runtime = "nodejs";

// Public export is disabled. Keep the response indistinguishable across all
// token states and do not resolve or render any brief data.
export function GET() {
  return exportNotFoundResponse();
}
