import { NextRequest, NextResponse } from "next/server";
import { HttpError, canReadBrief, requireUser } from "@/lib/auth";
import { loadJournalDocumentDetail } from "@/lib/journalDocuments";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) return NextResponse.json(e.body, { status: e.status });
  return null;
}

// Returns the FULL extracted text of an uploaded document / imported link, for
// the document viewer. The list/preview endpoints only carry a 500-char excerpt.
export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string; documentId: string }> }
) {
  const params = await props.params;
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const document = loadJournalDocumentDetail(params.id, params.documentId);
  if (!document) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ document });
}
