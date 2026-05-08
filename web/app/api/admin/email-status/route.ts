import { NextRequest, NextResponse } from "next/server";
import { HttpError, requireAdmin } from "@/lib/auth";
import { isEmailConfigured } from "@/lib/email";

export const runtime = "nodejs";

// GET /api/admin/email-status — admin-only. Drives the admin banner.
export async function GET(req: NextRequest) {
  try {
    requireAdmin(req);
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json(e.body, { status: e.status });
    }
    throw e;
  }
  return NextResponse.json({ configured: isEmailConfigured() });
}
