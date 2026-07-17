/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === "production";

// Content-Security-Policy. Defense-in-depth: the app has no
// dangerouslySetInnerHTML and React escapes all rendered output, so there is no
// inline-injection sink today — this policy hardens against future regressions
// and third-party script loads. script/style use 'unsafe-inline' because Next's
// bootstrap and framer-motion emit inline script/style and Next 15's automatic
// per-request nonce did not engage here; 'self' still blocks EXTERNAL script
// origins (no `<script src=evil.com>`), and object-src/base-uri/frame-ancestors/
// form-action shut down object embedding, base-tag hijacking, clickjacking, and
// form exfiltration. Fonts load from Google (fonts.googleapis.com stylesheet →
// fonts.gstatic.com woff2). Dev adds 'unsafe-eval' for React Fast Refresh;
// upgrade-insecure-requests is prod-only so it never fights http://localhost.
const cspDirectives = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isProd ? ["upgrade-insecure-requests"] : []),
].join("; ");

module.exports = {
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
    // Next 15: instrumentationHook was removed — instrumentation.ts is stable
    // and always enabled, so the flag is simply dropped.
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: cspDirectives },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};
