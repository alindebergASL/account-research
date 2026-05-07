"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LogOut, ShieldCheck } from "lucide-react";

type Me = {
  id: string;
  email: string;
  role: "admin" | "member";
  display_name: string | null;
  must_change_password: boolean;
} | null;

export default function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { user: null }))
      .then((d) => {
        setMe(d.user);
        if (
          d.user?.must_change_password &&
          pathname !== "/change-password" &&
          pathname !== "/login"
        ) {
          router.replace(
            `/change-password?from=${encodeURIComponent(pathname || "/")}`,
          );
        }
      })
      .catch(() => setMe(null));
  }, [pathname, router]);

  if (pathname === "/login" || pathname === "/change-password") return null;

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

  return (
    <header className="border-b border-[var(--line)] bg-white/60 backdrop-blur sticky top-0 z-20">
      <div className="max-w-7xl mx-auto px-6 h-12 flex items-center gap-4">
        <Link
          href="/"
          className="text-sm font-medium tracking-tight hover:text-accent transition-colors"
        >
          AccountBriefBuilder
        </Link>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {me?.role === "admin" && (
            <Link
              href="/admin"
              className="inline-flex items-center gap-1.5 text-muted hover:text-ink transition-colors"
            >
              <ShieldCheck className="size-4" /> Admin
            </Link>
          )}
          {me && (
            <>
              <span className="text-muted hidden sm:inline">{me.email}</span>
              <button
                type="button"
                onClick={logout}
                disabled={loading}
                className="inline-flex items-center gap-1.5 text-muted hover:text-ink transition-colors disabled:opacity-50"
                aria-label="Sign out"
              >
                <LogOut className="size-4" />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
