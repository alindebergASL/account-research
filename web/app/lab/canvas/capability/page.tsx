import { notFound } from "next/navigation";
import { hermesGenerativeCanvasEnabled } from "@/lib/hermes/config";
import { CapabilityProposalClient } from "./CapabilityProposalClient";

export const dynamic = "force-dynamic";

export default function CapabilityProposalPage({ searchParams }: { searchParams: { briefId?: string; capabilityProposalId?: string } }) {
  if (!hermesGenerativeCanvasEnabled()) notFound();
  const { briefId, capabilityProposalId } = searchParams;
  if (!briefId || !capabilityProposalId) {
    return <main className="min-h-screen bg-slate-950 p-8 text-slate-100"><h1 className="text-2xl font-semibold">Capability proposal viewer</h1><p className="mt-2 text-slate-400">Provide ?briefId=&lt;id&gt;&amp;capabilityProposalId=&lt;id&gt;. Source is fetched as JSON and rendered as text inside a pre element.</p></main>;
  }
  return <main className="min-h-screen bg-slate-950 p-6"><CapabilityProposalClient briefId={briefId} capabilityProposalId={capabilityProposalId} /></main>;
}
