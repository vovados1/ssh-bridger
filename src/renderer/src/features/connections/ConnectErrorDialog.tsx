import type { FsError } from '@shared/fs-types'
import { Dialog } from '../../components/Dialog'
import styles from './connections.module.css'

/** Shown for a host key we refuse to trust. Unlike a toast it stays until dismissed. */
export function ConnectErrorDialog({
  profileName,
  error,
  onClose
}: {
  profileName: string
  error: FsError
  onClose(): void
}) {
  return (
    <Dialog
      title={`Not connected to ${profileName}`}
      width={480}
      onClose={onClose}
      footer={
        <button data-primary="true" autoFocus onClick={onClose}>
          Close
        </button>
      }
    >
      <p className={styles.warning} role="alert">
        {error.message}
      </p>
    </Dialog>
  )
}
