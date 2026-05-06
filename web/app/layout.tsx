import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AccountBriefBuilder",
  description: "Live account research and brief generation.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
