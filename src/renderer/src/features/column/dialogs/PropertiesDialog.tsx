import { useEffect, useState } from 'react'
import type { Entry, EntryDetails } from '@shared/fs-types'
import { parentOf } from '@shared/posix-path'
import { Dialog } from '../Dialog'
import { describeType, formatDateTime, formatMode, formatSize } from '../format'
import { modeToOctal } from '../mode'
import styles from './dialogs.module.css'

interface Props {
  /** What to describe; for several items only `entries` is used (no per-item lookup). */
  paths: string[]
  entries: Entry[]
  loadDetails(path: string): Promise<EntryDetails>
  onClose(): void
}

export function PropertiesDialog({ paths, entries, loadDetails, onClose }: Props) {
  const single = paths.length === 1 ? paths[0]! : null
  const [details, setDetails] = useState<EntryDetails | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (single === null) return
    let stale = false
    loadDetails(single).then(
      (d) => !stale && setDetails(d),
      (e: unknown) => !stale && setError(e instanceof Error ? e.message : String(e))
    )
    return () => {
      stale = true
    }
  }, [single, loadDetails])

  const close = (
    <button data-primary="true" autoFocus onClick={onClose}>
      Close
    </button>
  )

  if (single === null) {
    const files = entries.filter((e) => e.type === 'file')
    const folders = entries.filter((e) => e.type === 'dir')
    return (
      <Dialog title={`Properties: ${entries.length} items`} onClose={onClose} footer={close}>
        <dl className={styles.props}>
          <dt>Items</dt>
          <dd>
            {files.length} {files.length === 1 ? 'file' : 'files'}, {folders.length}{' '}
            {folders.length === 1 ? 'folder' : 'folders'}
          </dd>
          <dt>Size of files</dt>
          <dd>{formatSize(files.reduce((sum, e) => sum + e.size, 0))}</dd>
        </dl>
      </Dialog>
    )
  }

  const d = details
  return (
    <Dialog title={`Properties: ${d?.name ?? '…'}`} onClose={onClose} footer={close} width={460}>
      {error && <p className={styles.note}>{error}</p>}
      {d && (
        <dl className={styles.props}>
          <dt>Name</dt>
          <dd>{d.name}</dd>
          <dt>Type</dt>
          <dd>{describeType(d)}</dd>
          <dt>Location</dt>
          <dd>{parentOf(d.path)}</dd>
          {d.type === 'symlink' && (
            <>
              <dt>Links to</dt>
              <dd>{d.linkTarget ?? 'unknown'}</dd>
            </>
          )}
          {d.type === 'file' && (
            <>
              <dt>Size</dt>
              <dd>
                {formatSize(d.size)} ({d.size.toLocaleString()} bytes)
              </dd>
            </>
          )}
          <dt>Modified</dt>
          <dd>{formatDateTime(d.mtime)}</dd>
          <dt>Accessed</dt>
          <dd>{formatDateTime(d.atime)}</dd>
          <dt>Changed</dt>
          <dd>{formatDateTime(d.ctime)}</dd>
          <dt>Permissions</dt>
          <dd>
            <code>{formatMode(d.type, d.mode)}</code> ({modeToOctal(d.mode)})
          </dd>
          <dt>Owner</dt>
          <dd>{d.owner ? `${d.owner} (${d.uid})` : d.uid}</dd>
          <dt>Group</dt>
          <dd>{d.group ? `${d.group} (${d.gid})` : d.gid}</dd>
        </dl>
      )}
    </Dialog>
  )
}
