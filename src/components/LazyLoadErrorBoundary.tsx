import { Component, type ErrorInfo, type ReactNode } from 'react'

interface LazyLoadErrorBoundaryProps {
  children: ReactNode
  fallback: ReactNode
}

interface LazyLoadErrorBoundaryState {
  failed: boolean
}

export default class LazyLoadErrorBoundary extends Component<
  LazyLoadErrorBoundaryProps,
  LazyLoadErrorBoundaryState
> {
  state: LazyLoadErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): LazyLoadErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Lazy-loaded UI failed:', error, info.componentStack)
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
