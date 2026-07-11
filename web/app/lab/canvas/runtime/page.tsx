import { notFound } from "next/navigation";
import { hermesGenerativeCanvasEnabled } from "@/lib/hermes/config";
import { CanvasRuntimeClient } from "./CanvasRuntimeClient";

export const dynamic = "force-dynamic";

export default async function CanvasRuntimePage(props: { searchParams: Promise<{ briefId?: string }> }) {
  const searchParams = await props.searchParams;
  if (!hermesGenerativeCanvasEnabled()) notFound();
  const briefId = searchParams.briefId;
  if (!briefId) {
    return <main className="min-h-screen bg-slate-950 p-8 text-slate-100"><h1 className="text-2xl font-semibold">Generative Canvas Runtime</h1><p className="mt-2 text-slate-400">Provide ?briefId=&lt;id&gt;. This route is authenticated by middleware; data APIs also enforce requireUser + canReadBrief.</p></main>;
  }
  return <main className="min-h-screen bg-slate-950 p-6"><CanvasRuntimeClient briefId={briefId} /></main>;
}
