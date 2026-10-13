import { useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import { stemLength } from '@shared/names'
import styles from './FileList.module.css'

interface Props {
  initial: string
  /** Folders are selected whole; files without their extension, so typing keeps `.txt`. */
  isDir: boolean
  /** Resolves to false when the name was rejected and editing should continue. */
  onCommit(name: string): Promise<boolean>
  onCancel(): void
}

export function RenameInput({ initial, isDir, onCommit, onCancel }: Props) {
  const ref = useRef<HTMLInputElement>(null)
  /** Set once Enter/Esc/blur has been handled so the others don't fire a second time. */
  const finished = useRef(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(0, isDir ? initial.length : stemLength(initial))
    return () => {
      // The row can unmount while editing (scrolled away, folder refreshed); that is not a blur by the user.
      finished.current = true
    }
  }, [initial, isDir])

  const commit = async (value: string, cancelIfRejected: boolean): Promise<void> => {
    if (finished.current) return
    finished.current = true
    if (await onCommit(value)) return
    if (cancelIfRejected) onCancel()
    else finished.current = false
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation() // keep list shortcuts (Delete, Backspace, ...) out of the text field
    if (e.key === 'Enter') {
      e.preventDefault()
      void commit(e.currentTarget.value, false)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finished.current = true
      onCancel()
    }
  }

  return (
    <input
      ref={ref}
      className={styles.renameInput}
      defaultValue={initial}
      spellCheck={false}
      aria-label="New name"
      onKeyDown={onKeyDown}
      onBlur={(e) => void commit(e.currentTarget.value, true)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    />
  )
}
