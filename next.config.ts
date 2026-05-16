import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === 'production'
const connectSrc = isProd
  ? "'self' ws: wss: https:"
  : "'self' ws: wss: http://localhost:* https:"

// SECURITY FIX: Removed generateNonce() from next.config.ts.
// Next.js headers() config function is evaluated at server startup, not per-request.
// This means the nonce was static across all requests, defeating its purpose.
// Instead, we use a {NONCE} placeholder that gets replaced per-request in middleware.
// The middleware (middleware.ts) generates a fresh nonce for each request and
// replaces the placeholder in the CSP header.

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
      isProd
        ? "script-src 'self' 'nonce-{NONCE}'"
        : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: http: https:",
      "font-src 'self' data:",
      "connect-src " + connectSrc,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
  async headers() {
    // SECURITY FIX: No longer generate nonce here. The {NONCE} placeholder
    // in the CSP header will be replaced per-request by middleware.ts using
    // a cryptographically random nonce generated for each incoming request.
    // This ensures each response has a unique nonce, making CSP effective
    // against XSS attacks.
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ]
  },
};

export default nextConfig;
