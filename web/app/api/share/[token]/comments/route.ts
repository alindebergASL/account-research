import { NextRequest } from "next/server";
import { publicNotFoundResponse } from "@/lib/publicShareAccess";

export const runtime = "nodejs";

// Public comments are disabled. This fixed response intentionally does not
// resolve the token or touch comment storage.
export async function GET(
  _req: NextRequest,
  _props: { params: Promise<{ token: string }> },
) {
  return publicNotFoundResponse();
}
