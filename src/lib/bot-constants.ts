/** Emoji options available when creating / editing a bot */
export const EMOJI_OPTIONS = [
  '🤖', '💬', '📊', '🎮', '📢', '🔔', '🛡️', '⚡',
  '🔥', '🌐', '💰', '🎯', '📈', '📱', '💡', '🎨',
  '🔍', '📦', '⭐', '🏷️', '🐙', '🦊', '🐱', '🐶',
  '🐸',
]

/**
 * Shared sensitive key patterns for auto-encryption detection.
 *
 * Used by BOTH:
 * - Server-side: crypto.ts — encryptEnvVarsOnSaveAsync() decides which vars to encrypt
 * - Client-side: env-vars-tab.tsx — shows 🔒 badge on sensitive keys
 *
 * IMPORTANT: Keep this list in sync between client and server.
 * If you add a pattern here, it will be applied on both sides automatically.
 */
export const SENSITIVE_KEY_PATTERNS = [
  'token',
  'secret',
  'password',
  'auth',
  'apikey',
  'api_key',
  'private',
  'key',
  'credential',
]

export const LANGUAGE_LABELS: Record<string, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
}

/**
 * Pagination defaults for API list endpoints.
 * - DEFAULT_PAGE_SIZE: standard list page size for UI display
 * - MAX_PAGE_SIZE: upper limit to prevent unbounded queries
 * - HYDRATION_PAGE_SIZE: page size for initial data hydration (balances performance vs memory)
 * - INFINITE_SCROLL_PAGE_SIZE: page size for incremental loading (when user scrolls)
 */
export const PAGINATION = {
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 1000,
  HYDRATION_PAGE_SIZE: 100,
  INFINITE_SCROLL_PAGE_SIZE: 50,
} as const
