import { NextResponse } from "next/server";

export function exportNotFoundResponse(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
