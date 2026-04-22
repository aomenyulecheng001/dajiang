'use client'

import { useEffect } from 'react'
import { useI18nStore } from '@/lib/i18n'

export function HtmlLang() {
  const locale = useI18nStore((s) => s.locale)
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  return null
}
