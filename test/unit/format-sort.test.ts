import { describe, expect, it } from 'vitest'
import type { Entry } from '@shared/fs-types'
import { formatDate, formatMode, formatSize } from '../../src/renderer/src/features/column/format'
import { computeVisible, sortEntries } from '../../src/renderer/src/features/column/sort'

const e = (name: string, over: Partial<Entry> = {}): Entry => ({
  name,
  path: '/' + name,
  type: 'file',
  size: 0,
  mtime: 0,
  mode: 0o644,
  ...over
})

describe('formatSize', () => {
  it('scales units', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(1023)).toBe('1023 B')
    expect(formatSize(1024)).toBe('1.0 KB')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(10 * 1024 * 1024)).toBe('10 MB')
    expect(formatSize(5 * 1024 ** 3)).toBe('5.0 GB')
  })
})

describe('formatMode', () => {
  it('renders ls-style strings', () => {
    expect(formatMode('file', 0o644)).toBe('-rw-r--r--')
    expect(formatMode('dir', 0o755)).toBe('drwxr-xr-x')
    expect(formatMode('symlink', 0o777)).toBe('lrwxrwxrwx')
    expect(formatMode('file', 0o4755)).toBe('-rwsr-xr-x')
    expect(formatMode('file', 0o4644)).toBe('-rwSr--r--')
    expect(formatMode('dir', 0o1777)).toBe('drwxrwxrwt')
    expect(formatMode('dir', 0o1770)).toBe('drwxrwx--T')
  })
})

describe('formatDate', () => {
  it('shows a dash for unknown times and omits the year for this year', () => {
    expect(formatDate(0)).toBe('—')
    const now = new Date(2026, 5, 15, 12).getTime()
    expect(formatDate(new Date(2026, 0, 2, 9, 5).getTime(), now)).not.toContain('2026')
    expect(formatDate(new Date(2024, 0, 2).getTime(), now)).toContain('2024')
  })
})

describe('sortEntries', () => {
  const list = [
    e('b.txt', { size: 5, mtime: 10 }),
    e('A.txt', { size: 9, mtime: 30 }),
    e('dir2', { type: 'dir' }),
    e('file10'),
    e('file9'),
    e('link-to-dir', { type: 'symlink', linkTargetType: 'dir' }),
    e('dir1', { type: 'dir' })
  ]

  it('puts folders (and links to folders) first, then sorts naturally and case-insensitively', () => {
    expect(sortEntries(list, 'name', 'asc').map((x) => x.name)).toEqual([
      'dir1',
      'dir2',
      'link-to-dir',
      'A.txt',
      'b.txt',
      'file9',
      'file10'
    ])
  })

  it('keeps folders first when descending', () => {
    const names = sortEntries(list, 'name', 'desc').map((x) => x.name)
    expect(names.slice(0, 3)).toEqual(['link-to-dir', 'dir2', 'dir1'])
    expect(names.slice(3)).toEqual(['file10', 'file9', 'b.txt', 'A.txt'])
  })

  it('sorts by size and mtime within groups and falls back to name', () => {
    expect(
      sortEntries(list, 'size', 'desc')
        .slice(3, 5)
        .map((x) => x.name)
    ).toEqual(['A.txt', 'b.txt'])
    expect(
      sortEntries(list, 'mtime', 'asc')
        .slice(3, 5)
        .map((x) => x.name)
    ).toEqual(['file9', 'file10'])
  })

  it('does not mutate its input', () => {
    const copy = [...list]
    sortEntries(list, 'size', 'desc')
    expect(list).toEqual(copy)
  })
})

describe('computeVisible', () => {
  it('hides dotfiles unless asked', () => {
    const entries = [e('.hidden'), e('shown')]
    expect(computeVisible(entries, false, 'name', 'asc').map((x) => x.name)).toEqual(['shown'])
    expect(computeVisible(entries, true, 'name', 'asc').map((x) => x.name)).toEqual([
      '.hidden',
      'shown'
    ])
  })
})
