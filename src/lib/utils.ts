import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { Locale } from "@/lib/i18n"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ─── Date Formatting ─────────────────────────────────────────────────────────

const timeTexts = {
  en: { justNow: 'just now', mAgo: 'm ago', hAgo: 'h ago', dAgo: 'd ago' },
  zh: { justNow: '刚刚', mAgo: '分钟前', hAgo: '小时前', dAgo: '天前' },
} as const;

export function formatDate(date: string, locale: Locale = 'zh'): string {
  if (!date) return ''
  const d = new Date(date)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  const t = timeTexts[locale]

  if (diffSec < 60) return t.justNow
  if (diffMin < 60) return `${diffMin}${t.mAgo}`
  if (diffHour < 24) return `${diffHour}${t.hAgo}`
  if (diffDay < 7) return `${diffDay}${t.dAgo}`

  return d.toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  })
}



// ─── Status Colors ───────────────────────────────────────────────────────────

export const statusConfig: Record<string, { label: string; className: string; dotClass: string }> = {
  active: {
    /** @deprecated Use getStatusLabel() for localized display text */
    label: 'Active',
    className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20',
    dotClass: 'bg-emerald-500',
  },
  inactive: {
    /** @deprecated Use getStatusLabel() for localized display text */
    label: 'Inactive',
    className: 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20',
    dotClass: 'bg-gray-400',
  },
  error: {
    /** @deprecated Use getStatusLabel() for localized display text */
    label: 'Error',
    className: 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20',
    dotClass: 'bg-red-500',
  },
  deploying: {
    /** @deprecated Use getStatusLabel() for localized display text */
    label: 'Deploying',
    className: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20',
    dotClass: 'bg-amber-500',
  },
}

export const healthConfig: Record<string, { label: string; className: string; dotClass: string }> = {
  healthy: {
    /** @deprecated Use getHealthLabel() for localized display text */
    label: 'Healthy',
    className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20',
    dotClass: 'bg-emerald-500',
  },
  warning: {
    /** @deprecated Use getHealthLabel() for localized display text */
    label: 'Warning',
    className: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20',
    dotClass: 'bg-amber-500',
  },
  critical: {
    /** @deprecated Use getHealthLabel() for localized display text */
    label: 'Critical',
    className: 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20',
    dotClass: 'bg-red-500',
  },
  unknown: {
    /** @deprecated Use getHealthLabel() for localized display text */
    label: 'Unknown',
    className: 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20',
    dotClass: 'bg-gray-400',
  },
}

/** Get localized status label */
export function getStatusLabel(key: string, locale: Locale = 'zh'): string {
  const map: Record<string, Record<Locale, string>> = {
    active: { en: 'Active', zh: '运行中' },
    inactive: { en: 'Inactive', zh: '已停用' },
    error: { en: 'Error', zh: '异常' },
    deploying: { en: 'Deploying', zh: '部署中' },
  }
  if (!key || !map[key]) {
    return map.inactive[locale] || statusConfig.inactive.label
  }
  return map[key][locale] || statusConfig[key]?.label || key
}

/** Get localized health label. Always prefer this over healthConfig[key].label */
export function getHealthLabel(key: string, locale: Locale = 'zh'): string {
  const map: Record<string, Record<Locale, string>> = {
    healthy: { en: 'Healthy', zh: '健康' },
    warning: { en: 'Warning', zh: '警告' },
    critical: { en: 'Critical', zh: '严重' },
    unknown: { en: 'Unknown', zh: '未知' },
  }
  return map[key]?.[locale] || healthConfig[key]?.label || key
}

// ─── Avatar Color ────────────────────────────────────────────────────────────

const avatarColors = [
  'from-teal-500 to-emerald-600',
  'from-rose-500 to-pink-600',
  'from-amber-500 to-orange-600',
  'from-emerald-500 to-teal-600',
  'from-cyan-500 to-blue-600',
  'from-fuchsia-500 to-pink-600',
]

export function getAvatarColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash)
  }
  return avatarColors[Math.abs(hash) % avatarColors.length]
}

// ─── Number Formatting ──────────────────────────────────────────────────────

/** Format large numbers with locale-aware separators (e.g., 1,234) */
export function formatNumber(n: number): string {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

// ─── Uptime Formatting ──────────────────────────────────────────────────────

/** Format seconds into a compact human-readable duration (e.g., "3d 5h", "45m", "12s") */
export function formatUptime(minutes: number, locale: Locale = 'zh'): string {
  if (minutes <= 0) return locale === 'zh' ? '离线' : 'Offline'
  const totalMinutes = Math.floor(minutes)
  if (totalMinutes < 60) return locale === 'zh' ? `${totalMinutes} 分钟` : `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const remainingMinutes = totalMinutes % 60
  if (hours < 24) {
    if (remainingMinutes === 0) return locale === 'zh' ? `${hours} 小时` : `${hours}h`
    return locale === 'zh' ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours}h ${remainingMinutes}m`
  }
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  if (remainingHours === 0) return locale === 'zh' ? `${days} 天` : `${days}d`
  return locale === 'zh' ? `${days} 天 ${remainingHours} 小时` : `${days}d ${remainingHours}h`
}

/** Format seconds into a compact short duration (e.g., "3d 5h", "45m", "12s") */
export function formatUptimeShort(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) return `${hours}h ${remainingMinutes}m`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return `${days}d ${remainingHours}h`
}

// ─── Token Validation ───────────────────────────────────────────────────────

/** Generate a UUID v4 (polyfill for crypto.randomUUID in non-HTTPS contexts)
 * Uses crypto.getRandomValues (available in HTTP) as fallback instead of Math.random
 */
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID()
    } catch {
      // crypto.randomUUID() throws in non-secure contexts (HTTP)
      // Fall through to getRandomValues fallback
    }
  }
  // Fallback using crypto.getRandomValues (works in HTTP contexts)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    // Set version (4) and variant bits per RFC 4122
    bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 1
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
  }
  // Last resort fallback (very rare)
  console.warn('[SECURITY] Using Math.random() for UUID generation - not cryptographically secure')
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** Generate a cryptographically secure secret string (64 hex chars = 256 bits)
 * Uses crypto.getRandomValues which works in both HTTP and HTTPS contexts.
 */
export function generateSecret(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(32) // 32 bytes = 64 hex chars
    crypto.getRandomValues(bytes)
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  }
  // Fallback using generateUUID (less ideal but works)
  return generateUUID().replace(/-/g, '') + generateUUID().replace(/-/g, '')
}

/** Check if a Telegram bot token has a valid format.
 *
 * Standard format: <bot_id>:<api_hash> (e.g. 123456789:ABCdefGHIjklMNOpqrsTUVwxyz)
 * Also accepts custom token formats for non-standard bot frameworks.
 * Minimum requirement: non-empty, contains at least one colon, reasonable length.
 */
export function isValidBotToken(token: string | undefined): boolean {
  if (!token) return false
  const trimmed = token.trim()
  if (trimmed.length < 10) return false
  if (!trimmed.includes(':')) return false
  // Reject default placeholder
  if (trimmed === 'your-token-here' || trimmed === 'your-token-here:placeholder') return false
  // Reject encrypted values (accidentally passing ciphertext as token)
  if (/^[0-9a-f]{32}:[0-9a-f]{32}:/.test(trimmed)) return false
  return true
}



