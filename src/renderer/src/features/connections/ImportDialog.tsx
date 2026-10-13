import { useEffect, useState } from 'react'
import type { SshConfigCandidate } from '@shared/connections'
import { Dialog } from '../../components/Dialog'
import { notify } from '../../lib/toasts'
import { connectionsStore } from '../../app/stores'
import styles from './connections.module.css'

export function ImportDialog({ onClose }: { onClose(): void }) {
  const [candidates, setCandidates] = useState<SshConfigCandidate[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let stale = false
    connectionsStore
      .getState()
      .listSshConfig()
      .then(
        (list) => {
          if (stale) return
          setCandidates(list)
          setPicked(new Set(list.filter((c) => !c.imported).map((c) => c.alias)))
        },
        (err: unknown) => {
          if (!stale)
            notify({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      )
    return () => {
      stale = true
    }
  }, [])

  const importable = (candidates ?? []).filter((c) => !c.imported)

  const toggle = (alias: string): void => {
    const next = new Set(picked)
    if (!next.delete(alias)) next.add(alias)
    setPicked(next)
  }

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const created = await connectionsStore.getState().importSshConfig([...picked])
      notify({
        kind: 'info',
        message: `Imported ${created.length} ${created.length === 1 ? 'connection' : 'connections'}`
      })
      onClose()
    } catch (err) {
      notify({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Import from ~/.ssh/config"
      width={520}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            data-primary="true"
            disabled={busy || picked.size === 0}
            onClick={() => void run()}
          >
            Import {picked.size > 0 ? picked.size : ''}
          </button>
        </>
      }
    >
      {candidates === null ? (
        <p className={styles.empty}>Reading your SSH config…</p>
      ) : candidates.length === 0 ? (
        <p className={styles.empty}>No hosts found in ~/.ssh/config.</p>
      ) : (
        <>
          <div className={styles.topActions}>
            <button onClick={() => setPicked(new Set(importable.map((c) => c.alias)))}>
              Select all
            </button>
            <button onClick={() => setPicked(new Set())}>Select none</button>
          </div>
          <ul className={styles.list}>
            {candidates.map((c) => (
              <li key={c.alias} className={styles.item}>
                <input
                  type="checkbox"
                  aria-label={c.alias}
                  checked={picked.has(c.alias)}
                  disabled={c.imported}
                  onChange={() => toggle(c.alias)}
                />
                <div className={styles.itemMain}>
                  <div className={styles.itemName}>{c.alias}</div>
                  <div className={styles.itemSub}>
                    {c.user ? `${c.user}@` : ''}
                    {c.hostName}
                    {c.port === 22 ? '' : `:${c.port}`}
                    {c.proxyJump ? ` · via ${c.proxyJump}` : ''}
                    {c.imported ? ' · already added' : ''}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  )
}
