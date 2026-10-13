import { toastStore, useToasts } from '../lib/toasts'
import styles from './ToastHost.module.css'

export function ToastHost() {
  const toasts = useToasts()
  return (
    <div className={styles.host} role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          className={styles.toast}
          data-kind={t.kind}
          role={t.kind === 'error' ? 'alert' : 'status'}
          title="Click to dismiss"
          onClick={() => toastStore.getState().dismiss(t.id)}
        >
          {t.message}
        </button>
      ))}
    </div>
  )
}
