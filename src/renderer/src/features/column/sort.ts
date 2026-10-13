import { isDirLike, type Entry } from '@shared/fs-types'

export type SortKey = 'name' | 'size' | 'mtime' | 'mode'
export type SortDir = 'asc' | 'desc'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function isHidden(entry: Entry): boolean {
  return entry.name.startsWith('.')
}

/** Folders always come first; `dir` only orders entries within each group. */
export function sortEntries(entries: readonly Entry[], key: SortKey, dir: SortDir): Entry[] {
  const sign = dir === 'asc' ? 1 : -1
  const byKey = (a: Entry, b: Entry): number => {
    switch (key) {
      case 'size':
        return a.size - b.size
      case 'mtime':
        return a.mtime - b.mtime
      case 'mode':
        return a.mode - b.mode
      default:
        return collator.compare(a.name, b.name)
    }
  }
  return [...entries].sort((a, b) => {
    const dirDiff = Number(isDirLike(b)) - Number(isDirLike(a))
    if (dirDiff !== 0) return dirDiff
    return sign * byKey(a, b) || collator.compare(a.name, b.name)
  })
}

export function computeVisible(
  entries: readonly Entry[],
  showHidden: boolean,
  key: SortKey,
  dir: SortDir
): Entry[] {
  return sortEntries(showHidden ? entries : entries.filter((e) => !isHidden(e)), key, dir)
}
