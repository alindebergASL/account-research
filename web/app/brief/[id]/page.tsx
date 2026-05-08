"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Brief } from "@/lib/schema";
import BriefCanvas from "@/components/BriefCanvas";

type Access = {
  is_owner: boolean;
  can_write: boolean;
  role: "owner" | "reader" | "editor" | null;
  shared_by_email: string | null;
};

export default function BriefPage({ params }: { params: { id: string } }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBrief(null);
    setAccess(null);
    setError(null);
    fetch(`/api/briefs/${params.id}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data?.error || `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        const parsed = Brief.parse(data.brief);
        setBrief(parsed);
        setAccess({
          is_owner: !!data.is_owner,
          can_write: !!data.can_write,
          role: data.role ?? null,
          shared_by_email: data.shared_by_email ?? null,
        });
      })
      .catch((e: any) => {
        if (cancelled) return;
        setError(e?.message || "Failed to load brief");
      });
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  if (error) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center">
          <p className="text-muted mb-4">{error}</p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-accent hover:underline"
          >
            <ArrowLeft className="size-4" /> Back home
          </Link>
        </div>
      </main>
    );
  }

  if (!brief || !access) {
    return (
      <main className="min-h-screen flex items-center justify-center text-muted">
        Loading brief…
      </main>
    );
  }

  return (
    <main className="min-h-screen">
      <nav className="max-w-7xl mx-auto px-6 pt-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-muted hover:text-ink transition-colors"
        >
          <ArrowLeft className="size-4" /> New research
        </Link>
      </nav>
      {!access.is_owner && access.shared_by_email && (
        <div className="max-w-7xl mx-auto px-6 mt-4">
          {access.role === "editor" ? (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-900">
              Shared with you by {access.shared_by_email} · editor
            </div>
          ) : (
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
              Shared with you by {access.shared_by_email} · reader
            </div>
          )}
        </div>
      )}
      <BriefCanvas
        brief={brief}
        currentBriefId={params.id}
        onBriefUpdate={setBrief}
        canWrite={access.can_write}
        isOwner={access.is_owner}
      />
    </main>
  );
}
