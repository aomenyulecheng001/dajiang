'use client'

import React from 'react'
import { useI18nStore, type Locale } from '@/lib/i18n'

const tabErrorTexts: Record<Locale, { error: string; retry: string }> = {
  en: { error: 'This section encountered an error', retry: 'Try again' },
  zh: { error: '此区域遇到了错误', retry: '重试' },
}

class TabErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: string },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; fallback?: string }) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[TabErrorBoundary]', error, info)
  }

  render() {
    if (this.state.hasError) {
      const locale = useI18nStore.getState().locale
      const texts = tabErrorTexts[locale] || tabErrorTexts.en
      return (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <p>{this.props.fallback || texts.error}</p>
          <button
            className="mt-2 text-sm text-primary hover:underline"
            onClick={() => this.setState({ hasError: false })}
          >
            {texts.retry}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export { TabErrorBoundary }
