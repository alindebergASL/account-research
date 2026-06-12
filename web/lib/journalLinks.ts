// Import a web link as a journal source. Fetches the URL server-side with SSRF
// guards and extracts readable text in the same bounded child process used for
// binary documents, returning an ExtractedJournalDocument the route stores like
// any upload.
//
// DNS-rebinding / TOCTOU defense: validation and the actual socket connection
// MUST use the same resolved IP. We achieve that with a pinned undici dispatcher
// whose connect.lookup resolves the host, rejects any private/reserved address,
// and hands undici exactly the address it validated — there is no second,
// independent DNS resolution between check and connect. This runs on every
// redirect hop (manual redirects), alongside a pre-flight check, size/timeout
// caps, and a content-type allowlist.

import net, { type LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { Agent, request as undiciRequest } from "undici";
import {
  extractHtmlTextSafely,
  MAX_DOCUMENT_BYTES,
  type ExtractedJournalDocument,
} from "./journalDocuments";

export const MAX_LINK_BYTES = MAX_DOCUMENT_BYTES;
const LINK_FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 4;
const REDIRECT_DRAIN_BYTES = 64 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
]);

export type FetchedLink = { finalUrl: string; html: string; contentType: string };
export type ResolvedAddr = { address: string; family: number };

// Minimal response shape fetchLink works against, so tests can drive redirect,
// content-type, size, and error handling without real network.
export type RawHttpResponse = {
  status: number;
  header: (name: string) => string | null;
  body: AsyncIterable<Uint8Array>;
};

// Test seams (no real network/DNS in tests):
//  - resolver: simulate what a hostname resolves to (incl. rebinding by
//    returning different addresses across calls).
//  - request: drive response handling directly.
//  - timeout: shorten the abort window.
type ResolveFn = (hostname: string) => Promise<ResolvedAddr[]>;
type RequestImpl = (
  url: string,
  signal: AbortSignal,
  dispatcher: Agent | null,
) => Promise<RawHttpResponse>;
let _testResolver: ResolveFn | null = null;
let _testRequest: RequestImpl | null = null;
let _testTimeoutMs: number | null = null;
export function __setTestResolver(f: ResolveFn | null) {
  _testResolver = f;
}
export function __setTestRequestImpl(f: RequestImpl | null) {
  _testRequest = f;
}
export function __setTestTimeoutMs(ms: number | null) {
  _testTimeoutMs = ms;
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

async function resolveHost(hostname: string): Promise<ResolvedAddr[]> {
  if (_testResolver) return _testResolver(hostname);
  const addrs = await dnsLookup(hostname, { all: true });
  return addrs.map((a) => ({ address: a.address, family: a.family }));
}

async function assertPublicHost(hostname: string): Promise<void> {
  // Pre-flight: a bare IP literal is checked directly; a name is resolved and
  // every returned address must be public. This is a fast, friendly-error gate;
  // pinnedLookup below is the authoritative connect-time enforcement.
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error("That link points to a private or reserved address");
    }
    return;
  }
  let addrs: ResolvedAddr[];
  try {
    addrs = await resolveHost(hostname);
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

// undici connect.lookup hook (Node dns.lookup signature). This is the IP the
// socket actually connects to, so validating here closes the rebinding window:
// if any resolved address is private/reserved we error before any connection.
function pinnedLookup(
  hostname: string,
  options: { all?: boolean; family?: number } | undefined,
  callback: (err: NodeJS.ErrnoException | null, address: string | ResolvedAddr[], family?: number) => void,
): void {
  const fail = (msg: string) =>
    callback(Object.assign(new Error(msg), { code: "EAI_BLOCKED" }), "", 0);
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) return fail("Blocked: link resolves to a private or reserved address");
    const fam = net.isIPv6(hostname) ? 6 : 4;
    if (options?.all) callback(null, [{ address: hostname, family: fam }]);
    else callback(null, hostname, fam);
    return;
  }
  resolveHost(hostname)
    .then((addrs) => {
      if (addrs.length === 0) return fail("Could not resolve the link's host");
      for (const a of addrs) {
        if (isPrivateIp(a.address)) {
          return fail("Blocked: link resolves to a private or reserved address");
        }
      }
      if (options?.all) callback(null, addrs);
      else callback(null, addrs[0].address, addrs[0].family);
    })
    .catch(() => fail("DNS resolution failed"));
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

async function readCapped(body: AsyncIterable<Uint8Array>, max: number): Promise<string> {
  let received = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    const b = Buffer.from(chunk);
    received += b.length;
    if (received > max) {
      throw new Error("Page is too large to import (max 2MB)");
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    await readCapped(body, REDIRECT_DRAIN_BYTES);
  } catch {
    /* best-effort: free the socket without surfacing drain errors */
  }
}

async function realRequest(
  url: string,
  signal: AbortSignal,
  dispatcher: Agent | null,
): Promise<RawHttpResponse> {
  const res = await undiciRequest(url, {
    dispatcher: dispatcher ?? undefined,
    method: "GET",
    signal,
    headers: {
      "user-agent": "AccountBriefBuilder/1.0 (+link-import)",
      accept: "text/html,application/xhtml+xml,text/plain",
    },
  });
  return {
    status: res.statusCode,
    header: (name) => {
      const v = res.headers[name.toLowerCase()];
      if (Array.isArray(v)) return v[0] ?? null;
      return typeof v === "string" ? v : v == null ? null : String(v);
    },
    body: res.body,
  };
}

export async function fetchLink(raw: string): Promise<FetchedLink> {
  let url = validateUrl(raw);
  const doRequest = _testRequest ?? realRequest;
  // Real path uses a per-import dispatcher that pins DNS to validated IPs; the
  // test seam supplies responses directly and needs no dispatcher.
  const agent = _testRequest ? null : new Agent({ connect: { lookup: pinnedLookup as unknown as LookupFunction } });
  const timeoutMs = _testTimeoutMs ?? LINK_FETCH_TIMEOUT_MS;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertPublicHost(url.hostname);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await doRequest(url.toString(), ctrl.signal, agent);
        if (res.status >= 300 && res.status < 400) {
          const loc = res.header("location");
          await drain(res.body);
          if (!loc) throw new Error("The link redirected without a destination");
          // Re-validate scheme/credentials of the redirect target; the host is
          // re-checked at the top of the next iteration and at connect time.
          url = validateUrl(new URL(loc, url).toString());
          continue;
        }
        if (res.status < 200 || res.status >= 300) {
          await drain(res.body);
          throw new Error(`Could not fetch the link (HTTP ${res.status})`);
        }
        const contentType = (res.header("content-type") || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        if (contentType && !ALLOWED_CONTENT_TYPES.has(contentType)) {
          await drain(res.body);
          throw new Error(`Unsupported link content type: ${contentType}`);
        }
        const declared = Number(res.header("content-length") || "");
        if (Number.isFinite(declared) && declared > MAX_LINK_BYTES) {
          await drain(res.body);
          throw new Error("Page is too large to import (max 2MB)");
        }
        const html = await readCapped(res.body, MAX_LINK_BYTES);
        return { finalUrl: url.toString(), html, contentType: contentType || "text/html" };
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error("The link redirected too many times");
  } finally {
    if (agent) await agent.close().catch(() => {});
  }
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
