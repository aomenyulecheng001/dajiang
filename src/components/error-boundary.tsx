'use client'

import React from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18nStore, type Locale } from '@/lib/i18n'
import { logger } from '@/lib/logger'

interface ErrorBoundaryProps {
  children: React.ReactNode
  fallback?: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

const errorTexts: Record<Locale, { title: string; description: string; tryAgain: string; contactAdmin: string }> = {
  en: {
    title: 'Something went wrong',
    description: 'An unexpected error occurred. Please try refreshing the page or click the button below to reset.',
    tryAgain: 'Try Again',
    contactAdmin: 'Contact administrator for details',
  },
  zh: {
    title: '出现了问题',
    description: '发生了意外错误。请尝试刷新页面或点击下方按钮重置。',
    tryAgain: '重试',
    contactAdmin: '请联系管理员获取详情',
  },
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error('error-boundary', 'Unhandled error', { message: error instanceof Error ? error.message : String(error), componentStack: errorInfo.componentStack })
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      const locale = useI18nStore.getState().locale
      const texts = errorTexts[locale] || errorTexts.en

      return (
        <div className="flex flex-col items-center justify-center min-h-[400px] p-8 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-destructive/10 mb-6">
            <AlertTriangle className="size-8 text-destructive" />
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">
            {texts.title}
          </h2>
          <p className="text-sm text-muted-foreground max-w-md mb-6">
            {texts.description}
          </p>
          {this.state.error && (
            <pre className={`text-xs rounded-lg p-4 max-w-lg w-full overflow-auto max-h-32 mb-6 font-mono ${
              process.env.NODE_ENV === 'production'
                ? 'text-muted-foreground/50 bg-muted/50'
                : 'text-muted-foreground/70 bg-muted'
            }`}>
              {process.env.NODE_ENV === 'production'
                ? `Error: ${this.state.error.name || 'Error'} — ${texts.contactAdmin}`
                : this.state.error.message
              }
            </pre>
          )}
          <Button
            variant="outline"
            onClick={this.handleReset}
            className="gap-2"
          >
            <RotateCcw className="size-4" />
            {texts.tryAgain}
          </Button>
        </div>
      )
    }

    return this.props.children
  }
}
