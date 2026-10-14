import { Component, type ErrorInfo, type ReactNode } from 'react'
import styles from './ErrorBoundary.module.css'

interface State {
  error: Error | null
}

/** Last line of defence: a bug in the UI shows a way out instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('UI crashed', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className={styles.crash} role="alert">
        <h1>Something went wrong</h1>
        <p>
          The window hit an unexpected error. Your files and connections are not affected, and
          transfers keep running.
        </p>
        <pre>{error.message}</pre>
        <button data-primary="true" onClick={() => window.location.reload()}>
          Reload window
        </button>
      </div>
    )
  }
}
