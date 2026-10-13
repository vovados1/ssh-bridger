import { useEffect } from 'react'
import { ColumnsArea } from './app/ColumnsArea'
import { DialogHost } from './app/DialogHost'
import { connectionsStore } from './app/stores'
import { ToastHost } from './app/ToastHost'
import { Toolbar } from './app/Toolbar'
import { PromptHost } from './features/connections/PromptHost'
import { notify } from './lib/toasts'
import styles from './App.module.css'

export function App() {
  useEffect(() => {
    connectionsStore
      .getState()
      .init()
      .catch((err: unknown) => {
        notify({
          kind: 'error',
          message: `Could not load connections: ${err instanceof Error ? err.message : String(err)}`
        })
      })
    return () => connectionsStore.getState().dispose()
  }, [])

  return (
    <div className={styles.app}>
      <Toolbar />
      <main className={styles.main}>
        <ColumnsArea />
      </main>
      <DialogHost />
      <PromptHost />
      <ToastHost />
    </div>
  )
}
