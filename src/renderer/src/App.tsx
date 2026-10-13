import { useEffect, useState } from 'react'
import { api } from './lib/api'

export function App() {
  const [home, setHome] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.fs.home().then(setHome, (e: unknown) => setError(String(e)))
  }, [])

  return (
    <main className="app">
      <h1>SSH Bridger</h1>
      {error ? (
        <p className="error">IPC failed: {error}</p>
      ) : (
        <p>
          Local home: <code>{home ?? '…'}</code>
        </p>
      )}
    </main>
  )
}
