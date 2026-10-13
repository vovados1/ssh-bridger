import type { Entry } from '@shared/fs-types'

const common = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true
} as const

export function FolderIcon() {
  return (
    <svg {...common}>
      <path d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5h6.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
    </svg>
  )
}

export function FileIcon() {
  return (
    <svg {...common}>
      <path d="M4 1.5h5l3.5 3.5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z" />
      <path d="M9 1.5V5h3.5" />
    </svg>
  )
}

export function OtherIcon() {
  return (
    <svg {...common}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M6 6.5h4M6 9.5h2.5" />
    </svg>
  )
}

export function EntryIcon({ entry }: { entry: Entry }) {
  const kind = entry.type === 'symlink' ? (entry.linkTargetType ?? 'broken') : entry.type
  if (kind === 'dir') return <FolderIcon />
  if (kind === 'file') return <FileIcon />
  return <OtherIcon />
}

export function BackIcon() {
  return (
    <svg {...common}>
      <path d="M9.5 3.5 5 8l4.5 4.5" />
    </svg>
  )
}

export function ForwardIcon() {
  return (
    <svg {...common}>
      <path d="M6.5 3.5 11 8l-4.5 4.5" />
    </svg>
  )
}

export function UpIcon() {
  return (
    <svg {...common}>
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  )
}

export function RefreshIcon() {
  return (
    <svg {...common}>
      <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />
    </svg>
  )
}

export function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg {...common}>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.8" />
      {off && <path d="M2.5 13.5 13.5 2.5" />}
    </svg>
  )
}
