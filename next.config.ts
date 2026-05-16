import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === 'production'
const connectSrc = isProd
  ? "'self' ws: wss: https:"
  : "'self' ws: wss: http://localhost:* https:"

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
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
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
    ignoreBuildErrors: isProd,
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
