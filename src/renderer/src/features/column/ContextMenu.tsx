import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import styles from './ContextMenu.module.css'

export type MenuItem =
  | { separator: true }
  | {
      label: string
      shortcut?: string
      disabled?: boolean
      /** Shows a check mark; for toggles. */
      checked?: boolean
      danger?: boolean
      onSelect(): void
    }

const isSeparator = (item: MenuItem): item is { separator: true } => 'separator' in item

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose(): void
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const enabled = items.flatMap((item, i) => (isSeparator(item) || item.disabled ? [] : [i]))
  const [active, setActive] = useState<number | null>(enabled[0] ?? null)

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - height - 4))
    })
    el.focus()
  }, [x, y])

  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [onClose])

  const move = (delta: number) => {
    if (enabled.length === 0) return
    const at = active === null ? -1 : enabled.indexOf(active)
    setActive(enabled[(at + delta + enabled.length) % enabled.length] ?? null)
  }

  const choose = (item: MenuItem | undefined) => {
    if (!item || isSeparator(item) || item.disabled) return
    onClose()
    item.onSelect()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation() // the column must not see keys meant for the menu
    switch (e.key) {
      case 'ArrowDown':
        move(1)
        break
      case 'ArrowUp':
        move(-1)
        break
      case 'Home':
        setActive(enabled[0] ?? null)
        break
      case 'End':
        setActive(enabled.at(-1) ?? null)
        break
      case 'Enter':
      case ' ':
        choose(active === null ? undefined : items[active])
        break
      case 'Escape':
        onClose()
        break
      default:
        return
    }
    e.preventDefault()
  }

  return (
    <div
      ref={ref}
      className={styles.menu}
      role="menu"
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onClose()
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        isSeparator(item) ? (
          <div key={i} className={styles.separator} role="separator" />
        ) : (
          <div
            key={i}
            className={styles.item}
            role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.checked}
            aria-disabled={item.disabled}
            data-active={active === i}
            data-danger={item.danger}
            onMouseEnter={() => !item.disabled && setActive(i)}
            onClick={() => choose(item)}
          >
            <span className={styles.check}>{item.checked ? '✓' : ''}</span>
            <span className={styles.label}>{item.label}</span>
            {item.shortcut && <span className={styles.shortcut}>{item.shortcut}</span>}
          </div>
        )
      )}
    </div>
  )
}
