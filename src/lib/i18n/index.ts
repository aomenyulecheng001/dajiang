import { useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { en } from './locales/en';
import { zh } from './locales/zh';
import type { TranslationKeys } from './locales/en';

export type Locale = 'en' | 'zh';

const translations = { en, zh };

// Simple template interpolation: replace {key} with values
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return Object.entries(params).reduce(
    (str, [key, val]) => str.replaceAll(`{${key}}`, String(val)),
    template
  );
}

type NestedKeyOf<T> = T extends object
  ? {
      [K in keyof T & string]: T[K] extends object
        ? `${K}.${NestedKeyOf<T[K]>}`
        : K;
    }[keyof T & string]
  : never;

export type TranslationKey = NestedKeyOf<TranslationKeys>;

/**
 * Get a translation string by dotted key path
 * e.g. t('common.cancel') → '取消'
 * e.g. t('page.footerCopy', { year: '2025' }) → 'Bot Factory © 2025'
 */
export function getTranslation(locale: Locale, key: TranslationKey, params?: Record<string, string | number>): string {
  const keys = key.split('.');
  let result: unknown = translations[locale];
  for (const k of keys) {
    if (result && typeof result === 'object' && k in result) {
      result = (result as Record<string, unknown>)[k];
    } else {
      // Fallback to English if key not found in current locale
      let fallback: unknown = translations.en;
      for (const fk of keys) {
        if (fallback && typeof fallback === 'object' && fk in fallback) {
          fallback = (fallback as Record<string, unknown>)[fk];
        } else {
          return key; // Return the key itself as last resort
        }
      }
      return typeof fallback === 'string' ? interpolate(fallback, params) : key;
    }
  }
  return typeof result === 'string' ? interpolate(result, params) : key;
}

// ─── Zustand Store ─────────────────────────────────────────────────────────

interface I18nState {
  locale: Locale;
  setLocale: (_locale: Locale) => void;
}

export const useI18nStore = create<I18nState>()(
  persist(
    (set) => ({
      locale: 'zh' as Locale, // Default language is Chinese
      setLocale: (locale: Locale) => set({ locale }),
    }),
    {
      name: 'bot-factory-locale',
    }
  )
);

// ─── Hook ──────────────────────────────────────────────────────────────────

/**
 * useT() returns a bound translation function for the current locale.
 * Usage:
 *   const t = useT()
 *   <span>{t('common.cancel')}</span>
 *   <span>{t('dashboard.active', { n: 3 })}</span>
 */
// P2-26 FIX: Wrap returned function with useMemo to stabilize reference
export function useT() {
  const locale = useI18nStore((s) => s.locale);
  return useMemo(() => (key: string, params?: Record<string, string | number>) =>
    getTranslation(locale, key as TranslationKey, params), [locale]);
}

/** Convenience re-exports */
export const useLocale = () => useI18nStore((s) => s.locale);
export const setLocale = (locale: Locale) => useI18nStore.getState().setLocale(locale);

export { type TranslationKeys };
