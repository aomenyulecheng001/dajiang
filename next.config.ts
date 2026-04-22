import type { NextConfig } from "next";

// P1-HTTP-3 FIX: CSP connect-src should not allow http://localhost:* in production.
// In dev mode, localhost is needed for Socket.IO to bot-runner (same-host).
// In production, only 'self', ws:, wss:, and https: should be allowed.
// HTTP/HTTPS COMPAT: In production, also allow http: for non-HTTPS deployments.
// When deployed behind a reverse proxy that terminates TLS, the internal connection
// may be HTTP even though the external URL is HTTPS. Both protocols are supported.
const isProd = process.env.NODE_ENV === 'production'
const connectSrc = isProd
  ? "'self' ws: wss: https: http:"
  : "'self' ws: wss: http://localhost:* https:"

// H11 FIX: Content-Security-Policy headers to prevent XSS and code injection attacks
const securityHeaders = [
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
  ...(process.env.NODE_ENV === 'production' && process.env.PROTOCOL === 'https'
    ? [{
        key: 'Strict-Transport-Security',
        value: 'max-age=31536000; includeSubDomains',
      }]
    : []),
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // unsafe-inline/eval needed for Next.js dev/SSR
      "style-src 'self' 'unsafe-inline'", // unsafe-inline needed for Tailwind CSS
      "img-src 'self' data: blob: http: https:",
      "font-src 'self' data:",
      "connect-src " + connectSrc, // WebSocket for bot-runner + API
      "frame-ancestors 'none'", // Prevent embedding in iframes
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ]
  },
};

export default nextConfig;
