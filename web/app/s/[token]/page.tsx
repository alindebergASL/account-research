"use client";

import { useEffect, useState, use } from "react";
import { Brief } from "@/lib/schema";
import BriefCanvas from "@/components/BriefCanvas";

type State =
  | { kind: "loading" }
  | { kind: "ok"; brief: Brief; expires_at: number | null }
  | { kind: "missing" };

export default function PublicShareView(
  props: {
    params: Promise<{ token: string }>;
  }
) {
  const params = use(props.params);
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/share/${encodeURIComponent(params.token)}`, {
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error("missing");
        return r.json();
      })
      .then((d) => {
        if (cancelled) return;
        const parsed = Brief.safeParse(d.brief);
        if (!parsed.success) {
          setState({ kind: "missing" });
          return;
        }
        setState({
          kind: "ok",
          brief: parsed.data,
          expires_at: d.expires_at ?? null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ kind: "missing" });
      });
    return () => {
      cancelled = true;
    };
  }, [params.token]);

  if (state.kind === "loading") {
    return (
      <main className="min-h-screen flex items-center justify-center text-muted">
        Loading brief…
      </main>
    );
  }
  if (state.kind === "missing") {
    return (
      <main className="min-h-screen flex items-center justify-center px-6 py-16">
        <div className="text-center max-w-sm">
          <h1 className="font-display text-2xl mb-2">Link unavailable</h1>
          <p className="text-sm text-muted">
            This shared brief is unavailable. Ask whoever sent it for a new link.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen">
      <BriefCanvas
        brief={state.brief}
        mode="public"
        canWrite={false}
        isOwner={false}
      />
      {state.expires_at !== null && (
        <div className="max-w-7xl mx-auto px-6 pb-10 text-center text-xs text-muted">
          Shared via AccountBriefBuilder · this link {formatExpiryFooter(state.expires_at)}
        </div>
      )}
      {state.expires_at === null && (
        <div className="max-w-7xl mx-auto px-6 pb-10 text-center text-xs text-muted">
          Shared via AccountBriefBuilder
        </div>
      )}
    </main>
  );
}

function formatExpiryFooter(ts: number): string {
  const ms = ts - Date.now();
  if (ms <= 0) return "has expired";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `expires in ${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `expires in ${hours} hour${hours === 1 ? "" : "s"}`;
  return "expires soon";
}
