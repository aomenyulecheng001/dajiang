'use client'

import React from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ErrorBoundaryProps {
  children: React.ReactNode
  fallback?: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
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
    console.error('[ErrorBoundary] Unhandled error:', error, errorInfo)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="flex flex-col items-center justify-center min-h-[400px] p-8 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-destructive/10 mb-6">
            <AlertTriangle className="size-8 text-destructive" />
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">
            Something went wrong
          </h2>
          <p className="text-sm text-muted-foreground max-w-md mb-6">
            An unexpected error occurred. Please try refreshing the page or click the button below to reset.
          </p>
          {this.state.error && (
            <pre className={`text-xs rounded-lg p-4 max-w-lg w-full overflow-auto max-h-32 mb-6 font-mono ${
              process.env.NODE_ENV === 'production'
                ? 'text-muted-foreground/50 bg-muted/50'
                : 'text-muted-foreground/70 bg-muted'
            }`}>
              {process.env.NODE_ENV === 'production'
                ? `Error: ${this.state.error.name || 'Error'} — Contact administrator for details`
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
            Try Again
          </Button>
        </div>
      )
    }

    return this.props.children
  }
}
