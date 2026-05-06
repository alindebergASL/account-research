"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Brief } from "@/lib/schema";
import BriefCanvas from "@/components/BriefCanvas";

export default function BriefPage() {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const raw = sessionStorage.getItem("brief");
    if (!raw) {
      setError("No brief found. Start a new research from the home page.");
      return;
    }
    try {
      const parsed = Brief.parse(JSON.parse(raw));
      setBrief(parsed);
    } catch (e: any) {
      setError("Stored brief failed validation: " + (e?.message ?? String(e)));
    }
  }, []);

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

  if (!brief) {
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
      <BriefCanvas brief={brief} />
    </main>
  );
}
