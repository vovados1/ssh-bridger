import { useState, type FormEvent } from 'react'
import {
  DEFAULT_AUTH_METHODS,
  DEFAULT_SSH_PORT,
  type AuthMethodId,
  type ConnectionProfile
} from '@shared/connections'
import { Dialog } from '../../components/Dialog'
import { connectionsStore, useConnections, workspaceStore } from '../../app/stores'
import styles from './connections.module.css'

const METHOD_LABELS: Record<AuthMethodId, string> = {
  agent: 'SSH agent',
  publickey: 'Private key',
  password: 'Password',
  'keyboard-interactive': 'Keyboard-interactive (2FA)'
}

const COLORS = ['#e5484d', '#f76b15', '#f5d90a', '#30a46c', '#0091ff', '#8e4ec6']

interface Props {
  /** Edit this profile; omit to create one. */
  profileId?: string
  /** Offer (and make default) "Save & connect", for the New connection flow. */
  connectAfterSave?: boolean
  onClose(): void
}

export function ProfileEditorDialog({ profileId, connectAfterSave, onClose }: Props) {
  const profiles = useConnections((s) => s.profiles)
  const existing = profiles.find((p) => p.id === profileId)

  const [name, setName] = useState(existing?.name ?? '')
  const [host, setHost] = useState(existing?.host ?? '')
  const [port, setPort] = useState(String(existing?.port ?? DEFAULT_SSH_PORT))
  const [username, setUsername] = useState(existing?.username ?? '')
  const [methods, setMethods] = useState<Set<AuthMethodId>>(
    new Set(existing?.authMethods ?? DEFAULT_AUTH_METHODS)
  )
  const [identityFile, setIdentityFile] = useState(existing?.identityFile ?? '')
  const [jumpHostId, setJumpHostId] = useState(existing?.jumpHostId ?? '')
  const [defaultPath, setDefaultPath] = useState(existing?.defaultPath ?? '')
  const [color, setColor] = useState(existing?.color ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const linked = existing?.sshAlias
  const jumpCandidates = profiles.filter((p) => p.id !== profileId)

  const toggleMethod = (m: AuthMethodId): void => {
    const next = new Set(methods)
    if (!next.delete(m)) next.add(m)
    setMethods(next)
  }

  const browse = async (): Promise<void> => {
    const picked = await connectionsStore
      .getState()
      .pickFile('Choose a private key', identityFile || undefined)
    if (picked) setIdentityFile(picked)
  }

  const save = async (connect: boolean): Promise<void> => {
    setError(null)
    const portNumber = Number(port)
    if (!Number.isInteger(portNumber)) return setError('Port must be a number')
    setSaving(true)
    try {
      const input: Omit<ConnectionProfile, 'id'> & { id?: string } = {
        ...(existing ? { id: existing.id } : {}),
        name,
        host,
        port: portNumber,
        username,
        // Keep the standard order whatever the checkboxes were clicked in.
        authMethods: DEFAULT_AUTH_METHODS.filter((m) => methods.has(m)),
        ...(identityFile ? { identityFile } : {}),
        ...(jumpHostId ? { jumpHostId } : {}),
        ...(defaultPath ? { defaultPath } : {}),
        ...(color ? { color } : {}),
        ...(existing?.sshAlias ? { sshAlias: existing.sshAlias } : {})
      }
      const saved = await connectionsStore.getState().saveProfile(input)
      onClose()
      if (connect) void workspaceStore.getState().openRemote(saved.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault()
    void save(connectAfterSave ?? false)
  }

  return (
    <Dialog
      title={existing ? `Edit ${existing.name}` : 'New connection'}
      width={500}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={saving} onClick={() => void save(false)}>
            Save
          </button>
          <button
            type="button"
            data-primary="true"
            disabled={saving}
            onClick={() => void save(true)}
          >
            Save &amp; connect
          </button>
        </>
      }
    >
      <form className={styles.form} onSubmit={onSubmit}>
        {linked && (
          <p className={styles.muted}>
            Linked to <code>{linked}</code> in ~/.ssh/config. Host, port, user and key are re-read
            from there on every connect; the values below are only fallbacks.
          </p>
        )}
        <label className={styles.field}>
          Name
          <input
            type="text"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My server"
          />
        </label>
        <div className={styles.row}>
          <label className={styles.field}>
            Host
            <input
              type="text"
              value={host}
              spellCheck={false}
              onChange={(e) => setHost(e.target.value)}
              placeholder="server.example.com"
            />
          </label>
          <label className={styles.field}>
            Port
            <input
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </label>
        </div>
        <label className={styles.field}>
          User
          <input
            type="text"
            value={username}
            spellCheck={false}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Your local user name if empty"
          />
        </label>

        <fieldset className={styles.field} style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ padding: 0, marginBottom: 4 }}>Sign in with</legend>
          <div className={styles.methods}>
            {DEFAULT_AUTH_METHODS.map((m) => (
              <label key={m} className={styles.check}>
                <input type="checkbox" checked={methods.has(m)} onChange={() => toggleMethod(m)} />
                {METHOD_LABELS[m]}
              </label>
            ))}
          </div>
        </fieldset>

        {methods.has('publickey') && (
          <label className={styles.field}>
            Private key file
            <span className={styles.pathRow}>
              <input
                type="text"
                value={identityFile}
                spellCheck={false}
                onChange={(e) => setIdentityFile(e.target.value)}
                placeholder="Default keys in ~/.ssh"
              />
              <button type="button" onClick={() => void browse()}>
                Browse…
              </button>
            </span>
          </label>
        )}

        <label className={styles.field}>
          Connect through
          <select value={jumpHostId} onChange={(e) => setJumpHostId(e.target.value)}>
            <option value="">Directly</option>
            {jumpCandidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} (jump host)
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          Start in folder
          <input
            type="text"
            value={defaultPath}
            spellCheck={false}
            onChange={(e) => setDefaultPath(e.target.value)}
            placeholder="Home directory if empty"
          />
        </label>

        <div className={styles.field}>
          Color
          <div className={styles.swatches}>
            <button
              type="button"
              className={styles.swatch}
              data-none="true"
              aria-label="No color"
              aria-pressed={color === ''}
              onClick={() => setColor('')}
            />
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={styles.swatch}
                style={{ ['--swatch' as string]: c }}
                aria-label={`Color ${c}`}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>

        {error && (
          <p className={styles.fieldError} role="alert">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
