import { useState } from 'react'
import { Dialog } from '../../components/Dialog'
import { StatusDot } from '../../components/StatusDot'
import { notify } from '../../lib/toasts'
import { connectionsStore, useConnections, workspaceStore } from '../../app/stores'
import styles from './connections.module.css'

export function ManageDialog({ onClose }: { onClose(): void }) {
  const profiles = useConnections((s) => s.profiles)
  const states = useConnections((s) => s.states)
  const [confirming, setConfirming] = useState<string | null>(null)

  const show = workspaceStore.getState().showDialog

  const remove = async (id: string): Promise<void> => {
    try {
      await connectionsStore.getState().deleteProfile(id)
    } catch (err) {
      notify({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
    setConfirming(null)
  }

  return (
    <Dialog
      title="Connections"
      width={560}
      onClose={onClose}
      footer={
        <button data-primary="true" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className={styles.topActions}>
        <button onClick={() => show({ kind: 'profile', connectAfterSave: true })}>
          New connection…
        </button>
        <button onClick={() => show({ kind: 'import' })}>Import from ~/.ssh/config…</button>
      </div>
      {profiles.length === 0 ? (
        <p className={styles.empty}>No saved connections yet.</p>
      ) : (
        <ul className={styles.list}>
          {profiles.map((p) => {
            const state = states[p.id]
            const live = state?.status === 'connected' || state?.status === 'reconnecting'
            return (
              <li key={p.id} className={styles.item}>
                <StatusDot status={state?.status} />
                <div className={styles.itemMain}>
                  <div className={styles.itemName}>{p.name}</div>
                  <div className={styles.itemSub}>
                    {p.username ? `${p.username}@` : ''}
                    {p.host}
                    {p.port === 22 ? '' : `:${p.port}`}
                    {p.sshAlias ? ` · ssh config: ${p.sshAlias}` : ''}
                  </div>
                </div>
                <div className={styles.itemActions}>
                  {confirming === p.id ? (
                    <>
                      <button data-danger="true" onClick={() => void remove(p.id)}>
                        Delete
                      </button>
                      <button onClick={() => setConfirming(null)}>Keep</button>
                    </>
                  ) : (
                    <>
                      {live ? (
                        <button onClick={() => void connectionsStore.getState().disconnect(p.id)}>
                          Disconnect
                        </button>
                      ) : null}
                      <button
                        onClick={() => {
                          onClose()
                          void workspaceStore.getState().openRemote(p.id)
                        }}
                      >
                        {live ? 'Open' : 'Connect'}
                      </button>
                      <button onClick={() => show({ kind: 'profile', profileId: p.id })}>
                        Edit
                      </button>
                      <button onClick={() => setConfirming(p.id)} aria-label={`Delete ${p.name}`}>
                        ×
                      </button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Dialog>
  )
}
