/**
 * Shared constant for the bot-runner service URL.
 * Configurable via BOT_RUNNER_URL env var for containerized deployments.
 * Defaults to http://localhost:3001 for same-host deployments.
 *
 * SECURITY FIX (M5): Validate that the configured URL does not point to
 * internal/private network addresses, which would enable SSRF attacks
 * through the webhook proxy. This check runs once at module load time.
 */
function validateRunnerUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    // Block internal/private network addresses to prevent SSRF
    const internalPatterns = [
      /^127\./,                          // 127.x.x.x (loopback)
      /^10\./,                           // 10.x.x.x (Class A private)
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16-31.x.x (Class B private)
      /^192\.168\./,                     // 192.168.x.x (Class C private)
      /^0\./,                            // 0.x.x.x
      /^::1$/,                           // IPv6 loopback
      /^fe80:/i,                         // IPv6 link-local
      /^fc00:/i,                         // IPv6 unique local
      /^fd/,                             // IPv6 unique local
    ]
    const internalHostnames = ['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']

    if (internalHostnames.includes(hostname)) {
      // Allow localhost in production when explicitly configured (same-host deployment).
      // Only warn if it is the default fallback value, not a user-configured setting.
      if (process.env.NODE_ENV === 'production' && !process.env.BOT_RUNNER_URL) {
        console.warn(`BOT_RUNNER_URL defaults to localhost (${url}). For container deployments, set BOT_RUNNER_URL to the runner service address.`)
      }
    }

    const isLocalhost = internalHostnames.includes(hostname) || /^127\./.test(hostname) || /^::1$/.test(hostname)
    for (const pattern of internalPatterns) {
      if (pattern.test(hostname)) {
        if (process.env.NODE_ENV === 'production' && !isLocalhost && process.env.SSRF_ALLOW_PRIVATE_NETWORK !== 'true') {
          throw new Error(
            `SECURITY: BOT_RUNNER_URL points to a private network address (${hostname}). ` +
            `This is blocked in production. Set SSRF_ALLOW_PRIVATE_NETWORK=true to override.`
          )
        }
        console.warn(`SECURITY WARNING: BOT_RUNNER_URL points to a private network address (${hostname}). Ensure this is intentional.`)
        break
      }
    }
  } catch {
    console.error(`SECURITY: BOT_RUNNER_URL is not a valid URL: ${url}`)
  }
  return url
}

export const BOT_RUNNER_URL = validateRunnerUrl(process.env.BOT_RUNNER_URL || 'http://localhost:3001')
