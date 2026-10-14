import { useEffect } from 'react'
import { ColumnsArea } from './app/ColumnsArea'
import { DialogHost } from './app/DialogHost'
import { connectionsStore, settingsStore, transfersStore, workspaceStore } from './app/stores'
import { ToastHost } from './app/ToastHost'
import { Toolbar } from './app/Toolbar'
import { PromptHost } from './features/connections/PromptHost'
import { ConflictHost } from './features/transfers/ConflictDialog'
import { TransferPanel } from './features/transfers/TransferPanel'
import { notify } from './lib/toasts'
import styles from './App.module.css'

export function App() {
  useEffect(() => {
    const report = (what: string) => (err: unknown) =>
      notify({
        kind: 'error',
        message: `${what}: ${err instanceof Error ? err.message : String(err)}`
      })

    // Connections first: restoring the layout needs the profiles that remote columns refer to.
    void connectionsStore
      .getState()
      .init()
      .then(() => workspaceStore.getState().restore())
      .catch(report('Could not load connections'))
    void transfersStore.getState().init().catch(report('Could not load transfers'))
    void settingsStore.getState().init().catch(report('Could not load settings'))

    return () => {
      connectionsStore.getState().dispose()
      transfersStore.getState().dispose()
      settingsStore.getState().dispose()
    }
  }, [])

  // Ctrl+, opens the settings, like most desktop apps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        workspaceStore.getState().showDialog({ kind: 'settings' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className={styles.app}>
      <Toolbar />
      <main className={styles.main}>
        <ColumnsArea />
      </main>
      <TransferPanel />
      <DialogHost />
      <PromptHost />
      <ConflictHost />
      <ToastHost />
    </div>
  )
}
