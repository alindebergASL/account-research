// Import a web link as a journal source. Fetches the URL server-side with SSRF
// guards (protocol/credential checks, private-IP rejection on every redirect
// hop, size + timeout caps, content-type allowlist), extracts readable text in
// the same bounded subprocess used for binary documents, and returns an
// ExtractedJournalDocument the route stores like any upload.
//
// Residual risk: DNS rebinding between our lookup and fetch's own resolution is
// not fully eliminated (we validate resolved IPs but do not pin the socket).
// Acceptable for importing public web pages; documented as a follow-up.

import net from "node:net";
import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import {
  extractHtmlTextSafely,
  MAX_DOCUMENT_BYTES,
  type ExtractedJournalDocument,
} from "./journalDocuments";

export const MAX_LINK_BYTES = MAX_DOCUMENT_BYTES;
const LINK_FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 4;
const ALLOWED_CONTENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
]);

export type FetchedLink = { finalUrl: string; html: string; contentType: string };

// Test seam: inject page content without real network/DNS in tests.
type LinkFetcher = (rawUrl: string) => Promise<FetchedLink>;
let _testFetcher: LinkFetcher | null = null;
export function __setTestLinkFetcher(f: LinkFetcher | null) {
  _testFetcher = f;
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0 && p[2] === 0) return true; // 192.0.0.0/24
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true; // loopback / unspecified
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // unique-local
    if (low.startsWith("fe80")) return true; // link-local
    const mapped = low.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isPrivateIp(mapped[1]); // IPv4-mapped
    return false;
  }
  return true; // unparseable → treat as unsafe
}

async function assertPublicHost(hostname: string): Promise<void> {
  // A bare IP literal is checked directly; a name is resolved and every
  // returned address must be public.
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error("That link points to a private or reserved address");
    }
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    throw new Error("Could not resolve the link's host");
  }
  if (addrs.length === 0) throw new Error("Could not resolve the link's host");
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new Error("That link resolves to a private or reserved address");
    }
  }
}

function validateUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Enter a valid URL (including https://)");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http(s) links are supported");
  }
  if (u.username || u.password) {
    throw new Error("Links with embedded credentials are not allowed");
  }
  return u;
}

async function readBodyCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, max);
  let received = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.length;
      if (received > max) {
        await reader.cancel();
        throw new Error("Page is too large to import (max 2MB)");
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export async function fetchLink(raw: string): Promise<FetchedLink> {
  if (_testFetcher) return _testFetcher(raw);
  let url = validateUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(url.hostname);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LINK_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "user-agent": "AccountBriefBuilder/1.0 (+link-import)",
          accept: "text/html,application/xhtml+xml,text/plain",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error("The link redirected without a destination");
        url = validateUrl(new URL(loc, url).toString());
        continue;
      }
      if (!res.ok) throw new Error(`Could not fetch the link (HTTP ${res.status})`);
      const contentType = (res.headers.get("content-type") || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (contentType && !ALLOWED_CONTENT_TYPES.has(contentType)) {
        throw new Error(`Unsupported link content type: ${contentType}`);
      }
      const declared = Number(res.headers.get("content-length") || "");
      if (Number.isFinite(declared) && declared > MAX_LINK_BYTES) {
        throw new Error("Page is too large to import (max 2MB)");
      }
      const html = await readBodyCapped(res, MAX_LINK_BYTES);
      return { finalUrl: url.toString(), html, contentType: contentType || "text/html" };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("The link redirected too many times");
}

export async function importJournalLink(rawUrl: string): Promise<ExtractedJournalDocument> {
  const fetched = await fetchLink(rawUrl);
  const { title, text } = await extractHtmlTextSafely(fetched.html);
  const contentText = text.trim();
  if (!contentText) {
    throw new Error("No readable text could be extracted from that link");
  }
  let host = "link";
  try {
    host = new URL(fetched.finalUrl).hostname;
  } catch {
    /* keep default */
  }
  const filename =
    (title || host || "link").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180) || "link";
  return {
    filename,
    mimeType: "text/html",
    byteSize: Buffer.byteLength(fetched.html, "utf8"),
    contentHash: createHash("sha256").update(`${fetched.finalUrl}\n${contentText}`).digest("hex"),
    contentText,
    sourceUrl: fetched.finalUrl,
  };
}
