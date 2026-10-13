import { useRef, useState } from 'react'
import { ContextMenu, type MenuItem } from '../components/ContextMenu'
import { connectionsStore, useConnections, useWorkspace, workspaceStore } from './stores'
import styles from './Toolbar.module.css'

export function Toolbar() {
  const profiles = useConnections((s) => s.profiles)
  const states = useConnections((s) => s.states)
  const connecting = useWorkspace((s) => s.connecting)
  const loaded = useConnections((s) => s.loaded)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const show = workspaceStore.getState().showDialog

  const items = (): MenuItem[] => [
    ...(profiles.length === 0
      ? [{ label: 'No saved connections', disabled: true, onSelect: () => {} } satisfies MenuItem]
      : profiles.map((p): MenuItem => ({
          label: `${states[p.id]?.status === 'connected' ? '● ' : ''}${p.name}`,
          disabled: connecting.has(p.id),
          onSelect: () => void workspaceStore.getState().openRemote(p.id)
        }))),
    { separator: true },
    { label: 'New local column', onSelect: () => workspaceStore.getState().addLocalColumn() },
    { label: 'New connection…', onSelect: () => show({ kind: 'profile', connectAfterSave: true }) },
    { label: 'Import from ~/.ssh/config…', onSelect: () => show({ kind: 'import' }) },
    { label: 'Manage connections…', onSelect: () => show({ kind: 'manage' }) }
  ]

  return (
    <div className={styles.bar}>
      <button
        ref={buttonRef}
        className={styles.connect}
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        disabled={!loaded}
        onClick={() => {
          const r = buttonRef.current!.getBoundingClientRect()
          setMenuAt({ x: r.left, y: r.bottom + 4 })
        }}
      >
        <span aria-hidden>＋</span> Connect
      </button>
      {connecting.size > 0 && <span className={styles.note}>Connecting…</span>}
      {menuAt && (
        <ContextMenu x={menuAt.x} y={menuAt.y} items={items()} onClose={() => setMenuAt(null)} />
      )}
      <span className={styles.spacer} />
      <button
        className={styles.plain}
        title="Manage connections"
        onClick={() => {
          void connectionsStore.getState().reloadProfiles()
          show({ kind: 'manage' })
        }}
      >
        Connections
      </button>
    </div>
  )
}
