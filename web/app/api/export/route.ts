import { exportNotFoundResponse } from "@/lib/exportShutdown";

export const runtime = "nodejs";

// Private export is disabled for every caller and input. Keep this handler
// independent of request, authorization, persistence, and output generation.
export function POST() {
  return exportNotFoundResponse();
}
