import { useState } from 'react'
import { SETTING_LIMITS, type Settings, type ThemeChoice } from '@shared/settings'
import { Dialog } from '../../components/Dialog'
import { settingsStore, useSettings } from '../../app/stores'
import styles from './settings.module.css'

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'Follow the system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

const change = (fn: (s: Settings) => Settings) => void settingsStore.getState().update(fn)

export function SettingsDialog({ onClose }: { onClose(): void }) {
  const s = useSettings((state) => state.settings)

  return (
    <Dialog
      title="Settings"
      width={480}
      onClose={onClose}
      footer={
        <button data-primary="true" onClick={onClose}>
          Done
        </button>
      }
    >
      <p className={styles.note}>Changes apply right away.</p>

      <section className={styles.group}>
        <h3>Appearance</h3>
        <label className={styles.field}>
          <span>Theme</span>
          <select
            value={s.theme}
            onChange={(e) => change((cur) => ({ ...cur, theme: e.target.value as ThemeChoice }))}
          >
            {THEMES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className={styles.group}>
        <h3>Transfers</h3>
        <NumberField
          label="Files at once per transfer"
          hint="Applies to transfers started afterwards."
          limits={SETTING_LIMITS.filesPerTransfer}
          value={s.transfers.filesPerTransfer}
          onChange={(v) =>
            change((c) => ({ ...c, transfers: { ...c.transfers, filesPerTransfer: v } }))
          }
        />
        <NumberField
          label="Files at once in total"
          hint="Shared by all running transfers."
          limits={SETTING_LIMITS.totalFiles}
          value={s.transfers.totalFiles}
          onChange={(v) => change((c) => ({ ...c, transfers: { ...c.transfers, totalFiles: v } }))}
        />
        <NumberField
          label="Transfers at once"
          hint="Others wait in the queue."
          limits={SETTING_LIMITS.parallelTransfers}
          value={s.transfers.parallelTransfers}
          onChange={(v) =>
            change((c) => ({ ...c, transfers: { ...c.transfers, parallelTransfers: v } }))
          }
        />
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={s.transfers.preserveAttributes}
            onChange={(e) =>
              change((c) => ({
                ...c,
                transfers: { ...c.transfers, preserveAttributes: e.target.checked }
              }))
            }
          />
          <span>
            Keep permissions and modification times
            <small>
              Copies look like the originals. Turn off to stamp them with the current time.
            </small>
          </span>
        </label>
      </section>

      <section className={styles.group}>
        <h3>SSH folders</h3>
        <NumberField
          label="Refresh every (seconds)"
          hint="SSH servers can't announce changes, so open folders are re-read on this timer. 0 turns it off; F5 always works."
          limits={SETTING_LIMITS.remotePollSeconds}
          value={s.remotePollSeconds}
          onChange={(v) => change((c) => ({ ...c, remotePollSeconds: v }))}
        />
      </section>
      <p className={styles.version}>SSH Bridger {__APP_VERSION__}</p>
    </Dialog>
  )
}

interface NumberFieldProps {
  label: string
  hint: string
  limits: { min: number; max: number }
  value: number
  onChange(value: number): void
}

/** Keeps what you type until it is a valid whole number in range; only then does it apply. */
function NumberField({ label, hint, limits, value, onChange }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? String(value)
  const parsed = /^\d+$/.test(text) ? Number(text) : NaN
  const valid = parsed >= limits.min && parsed <= limits.max

  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        type="text"
        inputMode="numeric"
        className={styles.number}
        value={text}
        aria-invalid={!valid}
        onChange={(e) => {
          setDraft(e.target.value)
          const n = /^\d+$/.test(e.target.value) ? Number(e.target.value) : NaN
          if (n >= limits.min && n <= limits.max) onChange(n)
        }}
        onBlur={() => setDraft(null)}
      />
      <small>{valid ? hint : `Enter a whole number from ${limits.min} to ${limits.max}.`}</small>
    </label>
  )
}
