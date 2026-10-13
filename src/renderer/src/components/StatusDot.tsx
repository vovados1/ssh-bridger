import type { ConnectionStatus } from '@shared/connections'
import styles from './StatusDot.module.css'

const LABELS: Record<ConnectionStatus | 'idle', string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
  error: 'Connection failed',
  idle: 'Not connected'
}

export function StatusDot({ status }: { status: ConnectionStatus | undefined }) {
  const key = status ?? 'idle'
  return (
    <span
      className={styles.dot}
      data-status={key}
      role="img"
      aria-label={LABELS[key]}
      title={LABELS[key]}
    />
  )
}
