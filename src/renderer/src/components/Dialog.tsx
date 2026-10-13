import { useEffect, useRef, type ReactNode } from 'react'
import styles from './Dialog.module.css'

interface Props {
  title: string
  onClose(): void
  children: ReactNode
  /** Buttons, rendered right-aligned under the content. */
  footer: ReactNode
  width?: number
}

/** A modal on the native <dialog>: focus is trapped and Escape closes it for free. */
export function Dialog({ title, onClose, children, footer, width = 420 }: Props) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = ref.current
    if (el && !el.open) {
      el.showModal()
      // showModal() focuses the first button unless the HTML `autofocus` attribute is present,
      // which React does not render. Honor `data-autofocus` so the safe choice can be the default.
      el.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    }
    return () => el?.close()
  }, [])

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      style={{ width }}
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose() // click on the backdrop
      }}
      // Keys typed here must not reach the file list underneath.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <h2 className={styles.title}>{title}</h2>
      <div className={styles.body}>{children}</div>
      <div className={styles.footer}>{footer}</div>
    </dialog>
  )
}
