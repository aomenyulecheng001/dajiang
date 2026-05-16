'use client'

import React from 'react'

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
      return (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <p>{this.props.fallback || 'This section encountered an error'}</p>
          <button
            className="mt-2 text-sm text-primary hover:underline"
            onClick={() => this.setState({ hasError: false })}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export { TabErrorBoundary }
