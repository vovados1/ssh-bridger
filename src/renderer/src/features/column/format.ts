import type { Entry } from '@shared/fs-types'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`
}

const sameYear = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})
const otherYear = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
})

export function formatDate(mtime: number, now: number = Date.now()): string {
  if (mtime <= 0) return '—'
  const date = new Date(mtime)
  return (date.getFullYear() === new Date(now).getFullYear() ? sameYear : otherYear).format(date)
}

const TYPE_CHAR: Record<Entry['type'], string> = { file: '-', dir: 'd', symlink: 'l', other: '?' }

/** `ls -l` style, e.g. `drwxr-xr-x`, including setuid/setgid/sticky. */
export function formatMode(type: Entry['type'], mode: number): string {
  const bit = (mask: number, ch: string): string => (mode & mask ? ch : '-')
  const exec = (xMask: number, special: number, on: string, off: string): string => {
    const x = (mode & xMask) !== 0
    if (mode & special) return x ? on : off
    return x ? 'x' : '-'
  }
  return (
    TYPE_CHAR[type] +
    bit(0o400, 'r') +
    bit(0o200, 'w') +
    exec(0o100, 0o4000, 's', 'S') +
    bit(0o040, 'r') +
    bit(0o020, 'w') +
    exec(0o010, 0o2000, 's', 'S') +
    bit(0o004, 'r') +
    bit(0o002, 'w') +
    exec(0o001, 0o1000, 't', 'T')
  )
}
