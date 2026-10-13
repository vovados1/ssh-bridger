import { useState } from 'react'
import type { Entry } from '@shared/fs-types'
import { Dialog } from '../../../components/Dialog'
import { hasBit, modeToOctal, parseOctal, toggleBit, type ModeBit } from '../mode'
import styles from './dialogs.module.css'

const ROWS: { label: string; bits: [ModeBit, ModeBit, ModeBit] }[] = [
  { label: 'Owner', bits: ['ownerRead', 'ownerWrite', 'ownerExec'] },
  { label: 'Group', bits: ['groupRead', 'groupWrite', 'groupExec'] },
  { label: 'Others', bits: ['otherRead', 'otherWrite', 'otherExec'] }
]
const COLUMNS = ['Read', 'Write', 'Execute']
const SPECIAL: { label: string; bit: ModeBit }[] = [
  { label: 'Set user ID', bit: 'setuid' },
  { label: 'Set group ID', bit: 'setgid' },
  { label: 'Sticky', bit: 'sticky' }
]

interface Props {
  entries: Entry[]
  onApply(mode: number): void
  onClose(): void
}

export function PermissionsDialog({ entries, onApply, onClose }: Props) {
  const first = entries[0]
  const [mode, setMode] = useState(first?.mode ?? 0o644)
  const [octal, setOctal] = useState(modeToOctal(mode))
  const mixed = entries.some((e) => e.mode !== first?.mode)

  const update = (next: number) => {
    setMode(next)
    setOctal(modeToOctal(next))
  }
  const typedMode = parseOctal(octal)

  return (
    <Dialog
      title={
        entries.length === 1
          ? `Permissions: ${first?.name}`
          : `Permissions for ${entries.length} items`
      }
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            data-primary="true"
            disabled={typedMode === null}
            onClick={() => {
              if (typedMode === null) return
              onClose()
              onApply(typedMode)
            }}
          >
            Apply
          </button>
        </>
      }
    >
      {mixed && (
        <p className={styles.note}>
          The selected items have different permissions. Applying sets all of them to what is shown.
        </p>
      )}
      <table className={styles.grid}>
        <thead>
          <tr>
            <th />
            {COLUMNS.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              {row.bits.map((bit, i) => (
                <td key={bit}>
                  <input
                    type="checkbox"
                    aria-label={`${row.label} ${COLUMNS[i]!.toLowerCase()}`}
                    checked={hasBit(mode, bit)}
                    onChange={() => update(toggleBit(mode, bit))}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.special}>
        {SPECIAL.map(({ label, bit }) => (
          <label key={bit}>
            <input
              type="checkbox"
              checked={hasBit(mode, bit)}
              onChange={() => update(toggleBit(mode, bit))}
            />
            {label}
          </label>
        ))}
      </div>
      <label className={styles.octal}>
        Octal
        <input
          value={octal}
          spellCheck={false}
          aria-invalid={typedMode === null}
          onChange={(e) => {
            setOctal(e.target.value)
            const parsed = parseOctal(e.target.value)
            if (parsed !== null) setMode(parsed)
          }}
        />
      </label>
    </Dialog>
  )
}
