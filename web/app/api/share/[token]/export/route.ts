import { NextRequest } from "next/server";
import { publicNotFoundResponse } from "@/lib/publicShareAccess";

export const runtime = "nodejs";

// Public export is disabled. Keep the response indistinguishable across all
// token states and do not resolve or render any brief data.
export async function GET(
  _req: NextRequest,
  _props: { params: Promise<{ token: string }> },
) {
  return publicNotFoundResponse();
}
