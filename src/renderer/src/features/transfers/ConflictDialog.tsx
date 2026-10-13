import { useRef, useState } from 'react'
import type { ConflictPrompt, ConflictResolution, ConflictSide } from '@shared/transfers'
import { Dialog } from '../../components/Dialog'
import { transfersStore, useTransfers } from '../../app/stores'
import { formatDateTime, formatSize } from '../column/format'
import styles from './ConflictDialog.module.css'

/** Shows the oldest unanswered "that name is taken" question, one at a time. */
export function ConflictHost() {
  const conflict = useTransfers((s) => s.conflicts[0])
  return conflict ? <ConflictDialog key={conflict.id} conflict={conflict} /> : null
}

const TYPE_LABEL: Record<ConflictSide['type'], string> = {
  file: 'File',
  dir: 'Folder',
  symlink: 'Link',
  other: 'Item'
}

function Side({ title, side, newer }: { title: string; side: ConflictSide; newer: boolean }) {
  return (
    <div className={styles.side}>
      <h3>{title}</h3>
      <dl>
        <dt>Type</dt>
        <dd>{TYPE_LABEL[side.type]}</dd>
        {side.type !== 'dir' && (
          <>
            <dt>Size</dt>
            <dd>{formatSize(side.size)}</dd>
          </>
        )}
        <dt>Modified</dt>
        <dd>
          {formatDateTime(side.mtime)}
          {newer && <span className={styles.newer}> · newer</span>}
        </dd>
      </dl>
    </div>
  )
}

function ConflictDialog({ conflict }: { conflict: ConflictPrompt }) {
  const [applyToAll, setApplyToAll] = useState(false)
  /** Answer once: unmounting the dialog closes it, which fires onClose again. */
  const done = useRef(false)

  const answer = (resolution: ConflictResolution): void => {
    if (done.current) return
    done.current = true
    transfersStore.getState().resolveConflict(conflict.id, { resolution, applyToAll })
  }
  const abandon = (): void => {
    if (done.current) return
    done.current = true
    transfersStore.getState().abandonConflict(conflict.id)
  }

  const mismatch = conflict.kind === 'type-mismatch'
  const srcNewer = conflict.src.mtime > conflict.dst.mtime
  const dstNewer = conflict.dst.mtime > conflict.src.mtime

  return (
    <Dialog
      title={mismatch ? `“${conflict.name}” is in the way` : `“${conflict.name}” already exists`}
      width={560}
      onClose={abandon}
      footer={
        <>
          <button onClick={abandon}>Cancel transfer</button>
          <button onClick={() => answer('skip')}>Skip</button>
          {!mismatch && (
            <button onClick={() => answer('overwriteIfNewer')}>Overwrite if newer</button>
          )}
          {!mismatch && (
            <button data-danger="true" onClick={() => answer('overwrite')}>
              Overwrite
            </button>
          )}
          <button data-autofocus data-primary="true" onClick={() => answer('keepBoth')}>
            Keep both
          </button>
        </>
      }
    >
      {mismatch && (
        <p className={styles.note}>
          A {TYPE_LABEL[conflict.src.type].toLowerCase()} and a{' '}
          {TYPE_LABEL[conflict.dst.type].toLowerCase()} have the same name, so one cannot replace
          the other.
        </p>
      )}
      <div className={styles.sides}>
        <Side title="Copying" side={conflict.src} newer={srcNewer} />
        <Side title="Already there" side={conflict.dst} newer={dstNewer} />
      </div>
      <label className={styles.all}>
        <input
          type="checkbox"
          checked={applyToAll}
          onChange={(e) => setApplyToAll(e.target.checked)}
        />
        Do this for all remaining conflicts in this transfer
      </label>
    </Dialog>
  )
}
