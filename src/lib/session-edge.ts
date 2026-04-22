/**
 * Edge-compatible session validation.
 * 
 * This module does NOT import db.ts (Prisma) to remain compatible with
 * Next.js Edge Runtime (which runs in a V8 isolate without Node.js APIs).
 * 
 * Used exclusively in middleware.ts for request authentication.
 */

// ─── Constants ──────────────────────────────────────────────────────────
const HMAC_SECRET = process.env.HMAC_SECRET || ''
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

interface SessionPayload {
  userId: string
  username: string
  createdAt: number
}

// ─── HMAC Verification ──────────────────────────────────────────────────
async function hmacSign(data: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(HMAC_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

async function hmacVerify(data: string, signature: string): Promise<boolean> {
  const expected = await hmacSign(data)
  if (expected.length !== signature.length) return false
  let result = 0
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return result === 0
}

// ─── Base64URL ──────────────────────────────────────────────────────────
function base64UrlDecode(str: string): string {
  let padded = str.replace(/-/g, '+').replace(/_/g, '/')
  while (padded.length % 4) padded += '='
  return atob(padded)
}

// ─── Session Validation ─────────────────────────────────────────────────
export async function validateSessionEdge(token: string): Promise<{ userId: string; username: string } | null> {
  try {
    const dotIndex = token.indexOf('.')
    if (dotIndex === -1) return null

    const payloadB64 = token.slice(0, dotIndex)
    const signature = token.slice(dotIndex + 1)

    // Verify HMAC signature
    const valid = await hmacVerify(payloadB64, signature)
    if (!valid) return null

    // Decode payload
    const payloadStr = base64UrlDecode(payloadB64)
    const payload: SessionPayload = JSON.parse(payloadStr)

    // Check expiration
    if (Date.now() - payload.createdAt > SESSION_TTL_MS) {
      return null
    }

    return { userId: payload.userId, username: payload.username }
  } catch {
    return null
  }
}
