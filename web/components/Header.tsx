"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut, ShieldCheck } from "lucide-react";
import ResearchTray from "./ResearchTray";

type Me = {
  id: string;
  email: string;
  role: "admin" | "member" | "viewer";
  display_name: string | null;
  must_change_password: boolean;
} | null;

export default function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const hidden =
    pathname === "/login" ||
    pathname === "/change-password" ||
    pathname?.startsWith("/s/");

  useEffect(() => {
    if (hidden) return;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { user: null }))
      .then((d) => {
        setMe(d.user);
        const from = pathname || "/";
        if (!d.user) {
          router.replace(`/login?from=${encodeURIComponent(from)}`);
          return;
        }
        if (
          d.user.must_change_password &&
          pathname !== "/change-password" &&
          pathname !== "/login"
        ) {
          router.replace(`/change-password?from=${encodeURIComponent(from)}`);
        }
      })
      .catch(() => setMe(null));
  }, [pathname, router, hidden]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (hidden) return null;

  async function logout() {
    if (loading) return;
    setLoading(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  const localPart = me?.email?.split("@")[0] ?? "";

  return (
    <header className="border-b border-[var(--line)] bg-white/60 backdrop-blur sticky top-0 z-20">
      <div className="max-w-7xl mx-auto px-6 h-12 flex items-center gap-4">
        <Link
          href="/"
          className="text-sm font-medium tracking-tight hover:text-accent transition-colors"
        >
          AccountBriefBuilder
        </Link>
        <div className="ml-auto flex items-center gap-3 text-sm" ref={menuRef}>
          {me && me.role !== "viewer" && <ResearchTray />}
          {me && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 text-muted hover:text-ink transition-colors px-2 py-1 rounded-lg hover:bg-white border border-transparent hover:border-[var(--line)]"
                aria-haspopup="menu"
                aria-expanded={open}
              >
                <span className="max-w-[160px] truncate">{localPart}</span>
                {me.role === "viewer" && (
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--bg)] text-muted border border-[var(--line)]">
                    Read-only
                  </span>
                )}
                <ChevronDown
                  className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
                />
              </button>
              {open && (
                <div
                  role="menu"
                  className="absolute right-0 mt-2 w-60 bg-white border border-[var(--line)] rounded-xl shadow-xl overflow-hidden z-30"
                >
                  <div className="px-4 py-3 border-b border-[var(--line)]">
                    <div className="text-[11px] uppercase tracking-wider text-muted">
                      Signed in as
                    </div>
                    <div className="text-sm truncate">{me.email}</div>
                  </div>
                  {me.role === "admin" && (
                    <Link
                      href="/admin"
                      onClick={() => setOpen(false)}
                      className="flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-[var(--bg)] border-b border-[var(--line)]"
                    >
                      <ShieldCheck className="size-4 text-muted" /> Admin
                    </Link>
                  )}
                  <button
                    type="button"
                    onClick={logout}
                    disabled={loading}
                    className="w-full text-left flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-[var(--bg)] disabled:opacity-50"
                  >
                    <LogOut className="size-4 text-muted" /> Sign out
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
