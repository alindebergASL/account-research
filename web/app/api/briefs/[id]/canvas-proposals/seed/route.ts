import { NextRequest, NextResponse } from "next/server";
import { requireGenerativeCanvasWrite } from "@/lib/hermes/canvasRouteAuth";
import { seedReviewProposals } from "@/lib/hermes/canvasSeedFixtures";

export const runtime = "nodejs";

/**
 * POST /api/briefs/[id]/canvas-proposals/seed
 *
 * Lab/admin-only deterministic seed trigger for proposal review QA.
 * - No external provider/runtime calls.
 * - Auth via `requireGenerativeCanvasWrite` (flag + canWriteBrief).
 * - Idempotent per brief: re-clicking will not create duplicate proposals.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = requireGenerativeCanvasWrite(req, params.id);
  if (user instanceof NextResponse) return user;
  try {
    const result = seedReviewProposals({
      briefId: params.id,
      userId: user.id,
      proposedBy: "hermes",
      canWrite: true,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message ?? e) }, { status: 400 });
  }
}
