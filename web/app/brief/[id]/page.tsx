"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Brief } from "@/lib/schema";
import BriefCanvas from "@/components/BriefCanvas";
import ReadOnlyCanvasView from "@/components/canvas/ReadOnlyCanvasView";
import { buildReadOnlyCanvasFromBrief } from "@/lib/canvas/fromBrief";
import type { Canvas } from "@/lib/canvas/schema";
import CommentsSection from "./CommentsSection";
import JournalSection from "./JournalSection";

type Access = {
  is_owner: boolean;
  can_write: boolean;
  can_manage: boolean;
  role: "owner" | "reader" | "editor" | null;
  shared_by_email: string | null;
};

export default function BriefPage({ params }: { params: { id: string } }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [versionsCount, setVersionsCount] = useState<number>(0);
  const [monitorEnabled, setMonitorEnabled] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"brief" | "canvas" | "journal">(
    "brief",
  );
  const [persistedCanvas, setPersistedCanvas] = useState<Canvas | null>(null);
  const [canvasStateVersion, setCanvasStateVersion] = useState<number>(0);
  // Server-derived capability: true only when CANVAS_PREVIEW_ENABLED=1
  // AND the authenticated user is admin. The client treats this as
  // opaque — it cannot read the env var directly and shouldn't infer
  // anything from it beyond "render the toggle or not".
  const [canvasPreview, setCanvasPreview] = useState<boolean>(false);
  const [me, setMe] = useState<{ id: string; role: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { user: null }))
      .then((data) => {
        if (cancelled) return;
        if (data?.user?.id) {
          setMe({ id: data.user.id, role: data.user.role });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const canvas = useMemo(
    () =>
      persistedCanvas ??
      (canvasPreview && brief
        ? buildReadOnlyCanvasFromBrief({ briefId: params.id, brief })
        : null),
    [brief, canvasPreview, params.id, persistedCanvas],
  );

  useEffect(() => {
    let cancelled = false;
    setBrief(null);
    setAccess(null);
    setPersistedCanvas(null);
    setCanvasStateVersion(0);
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
          can_manage: !!data.can_manage,
          role: data.role ?? null,
          shared_by_email: data.shared_by_email ?? null,
        });
        setLastRefreshedAt(
          typeof data.last_refreshed_at === "number"
            ? data.last_refreshed_at
            : null,
        );
        setVersionsCount(
          typeof data.versions_count === "number" ? data.versions_count : 0,
        );
        setMonitorEnabled(data.monitor_enabled === true);
        setCanvasPreview(data.canvas_preview === true);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setError(e?.message || "Failed to load brief");
      });
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  const refreshCanvasState = useCallback(async () => {
    try {
      const res = await fetch(`/api/briefs/${params.id}/canvas-state`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.canvas && typeof data.version === "number") {
        setPersistedCanvas(data.canvas as Canvas);
        setCanvasStateVersion(data.version);
      }
    } catch {
      // Canvas refresh is opportunistic; the deterministic Canvas remains.
    }
  }, [params.id]);

  useEffect(() => {
    if (!canvasPreview) return;
    refreshCanvasState();
  }, [canvasPreview, params.id, refreshCanvasState]);

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
      <div className="max-w-7xl mx-auto px-6 mt-4">
        <div
          role="tablist"
          aria-label="View mode"
          className="inline-flex rounded-lg border border-[var(--line)] bg-white p-0.5 text-sm"
        >
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "brief"}
            onClick={() => setViewMode("brief")}
            className={`px-3 py-1.5 rounded-md transition-colors ${
              viewMode === "brief"
                ? "bg-ink text-white"
                : "text-muted hover:text-ink"
            }`}
          >
            Brief view
          </button>
          {canvasPreview && (
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "canvas"}
              onClick={() => setViewMode("canvas")}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                viewMode === "canvas"
                  ? "bg-ink text-white"
                  : "text-muted hover:text-ink"
              }`}
            >
              Canvas view
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "journal"}
            onClick={() => setViewMode("journal")}
            className={`px-3 py-1.5 rounded-md transition-colors ${
              viewMode === "journal"
                ? "bg-ink text-white"
                : "text-muted hover:text-ink"
            }`}
          >
            Journal
          </button>
        </div>
      </div>
      {viewMode === "journal" ? (
        me ? (
          <JournalSection
            briefId={params.id}
            currentUserId={me.id}
            isAdmin={me.role === "admin"}
            canManage={access.can_manage}
            briefContext={{
              account_name: brief.account_name,
              priority_summary: brief.priority_summary,
              next_action: brief.next_action,
              sources_count: brief.sources.length,
            }}
            onViewBriefBaseline={() => setViewMode("brief")}
          />
        ) : (
          <div className="max-w-7xl mx-auto px-6 mt-8 text-sm text-muted">
            Sign in to view the journal.
          </div>
        )
      ) : (
        <>
          {canvasPreview && viewMode === "canvas" && canvas ? (
            <ReadOnlyCanvasView key={canvasStateVersion} canvas={canvas} />
          ) : (
            <BriefCanvas
              brief={brief}
              currentBriefId={params.id}
              onBriefUpdate={setBrief}
              onHermesCanvasEvent={refreshCanvasState}
              canWrite={access.can_write}
              isOwner={access.is_owner}
              canManage={access.can_manage}
              monitorEnabled={monitorEnabled}
              lastRefreshedAt={lastRefreshedAt}
              versionsCount={versionsCount}
            />
          )}
          {me && (
            <CommentsSection
              briefId={params.id}
              currentUserId={me.id}
              isAdmin={me.role === "admin"}
            />
          )}
        </>
      )}
    </main>
  );
}
