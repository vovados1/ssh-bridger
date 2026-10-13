import { useRef, useState, type FormEvent } from 'react'
import type { PromptRequest, PromptResponse } from '@shared/connections'
import { Dialog } from '../../components/Dialog'
import { useConnections, connectionsStore } from '../../app/stores'
import styles from './connections.module.css'

/** Shows the oldest pending prompt from main, one at a time. */
export function PromptHost() {
  const prompt = useConnections((s) => s.prompts[0])
  if (!prompt) return null
  return <PromptDialog key={prompt.id} prompt={prompt} />
}

function PromptDialog({ prompt }: { prompt: PromptRequest }) {
  /** Answer exactly once: closing the dialog after an answer fires onClose again. */
  const answered = useRef(false)
  const answer = (response: PromptResponse | null): void => {
    if (answered.current) return
    answered.current = true
    connectionsStore.getState().answerPrompt(prompt.id, response)
  }

  switch (prompt.kind) {
    case 'hostkey':
      return <HostKeyDialog prompt={prompt} answer={answer} />
    case 'keyboard-interactive':
      return <KeyboardInteractiveDialog prompt={prompt} answer={answer} />
    default:
      return <SecretDialog prompt={prompt} answer={answer} />
  }
}

type Answer = (response: PromptResponse | null) => void

function HostKeyDialog({
  prompt,
  answer
}: {
  prompt: Extract<PromptRequest, { kind: 'hostkey' }>
  answer: Answer
}) {
  const where = prompt.port === 22 ? prompt.host : `${prompt.host}:${prompt.port}`
  return (
    <Dialog
      title={`Trust ${where}?`}
      width={520}
      onClose={() => answer(null)}
      footer={
        <>
          <button autoFocus onClick={() => answer(null)}>
            Cancel
          </button>
          <button onClick={() => answer({ kind: 'hostkey', accept: true, remember: false })}>
            Trust once
          </button>
          <button
            data-primary="true"
            onClick={() => answer({ kind: 'hostkey', accept: true, remember: true })}
          >
            Trust and remember
          </button>
        </>
      }
    >
      <p>
        <strong>{prompt.profileName}</strong> is connecting to a host this computer has not seen
        before. Check that the fingerprint matches what the server's administrator gave you.
      </p>
      <dl className={styles.facts}>
        <dt>Host</dt>
        <dd>{where}</dd>
        <dt>Key type</dt>
        <dd>{prompt.keyType}</dd>
        <dt>Fingerprint</dt>
        <dd className={styles.fingerprint}>{prompt.fingerprint}</dd>
      </dl>
      <p className={styles.muted}>
        “Trust and remember” adds the key to ~/.ssh/known_hosts, shared with the ssh command.
      </p>
    </Dialog>
  )
}

function SecretDialog({
  prompt,
  answer
}: {
  prompt: Extract<PromptRequest, { kind: 'password' | 'passphrase' }>
  answer: Answer
}) {
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(false)
  const isPassword = prompt.kind === 'password'

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    answer({ kind: prompt.kind, value, remember: remember && prompt.canRemember })
  }

  return (
    <Dialog
      title={isPassword ? `Password for ${prompt.profileName}` : 'Key passphrase'}
      onClose={() => answer(null)}
      footer={
        <>
          <button type="button" onClick={() => answer(null)}>
            Cancel
          </button>
          <button type="submit" form="secret-form" data-primary="true" disabled={value === ''}>
            Connect
          </button>
        </>
      }
    >
      <form id="secret-form" onSubmit={submit} className={styles.form}>
        {prompt.retry && (
          <p className={styles.warning} role="alert">
            That was not accepted. Try again.
          </p>
        )}
        <p className={styles.muted}>
          {isPassword ? `${prompt.username}@${prompt.host}` : `Unlock ${prompt.keyPath}`}
        </p>
        <input
          type="password"
          autoFocus
          autoComplete="off"
          aria-label={isPassword ? 'Password' : 'Passphrase'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <label
          className={styles.check}
          title={
            prompt.canRemember ? undefined : 'No system keyring is available to store it safely'
          }
        >
          <input
            type="checkbox"
            checked={remember && prompt.canRemember}
            disabled={!prompt.canRemember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Remember in the system keyring
        </label>
      </form>
    </Dialog>
  )
}

function KeyboardInteractiveDialog({
  prompt,
  answer
}: {
  prompt: Extract<PromptRequest, { kind: 'keyboard-interactive' }>
  answer: Answer
}) {
  const [values, setValues] = useState<string[]>(() => prompt.prompts.map(() => ''))
  const submit = (e: FormEvent): void => {
    e.preventDefault()
    answer({ kind: 'keyboard-interactive', answers: values })
  }
  return (
    <Dialog
      title={prompt.name || `Verification for ${prompt.profileName}`}
      onClose={() => answer(null)}
      footer={
        <>
          <button type="button" onClick={() => answer(null)}>
            Cancel
          </button>
          <button type="submit" form="ki-form" data-primary="true">
            Continue
          </button>
        </>
      }
    >
      <form id="ki-form" onSubmit={submit} className={styles.form}>
        {prompt.instructions && <p className={styles.muted}>{prompt.instructions}</p>}
        {prompt.prompts.map((p, i) => (
          <label key={i} className={styles.field}>
            {p.prompt}
            <input
              type={p.echo ? 'text' : 'password'}
              autoFocus={i === 0}
              autoComplete="off"
              value={values[i]}
              onChange={(e) => setValues(values.map((v, j) => (j === i ? e.target.value : v)))}
            />
          </label>
        ))}
      </form>
    </Dialog>
  )
}
