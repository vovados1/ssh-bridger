import { describe, expect, it } from 'vitest'
import { nameProblem, stemLength, uniqueName } from '@shared/names'
import { parseIdMap } from '../../src/main/fs/owners'

describe('nameProblem', () => {
  it('accepts ordinary names, including odd but legal ones', () => {
    for (const ok of ['a', 'New Folder', '.hidden', 'a.b.c', 'üñí', '-dash', 'x'.repeat(255)]) {
      expect(nameProblem(ok)).toBeNull()
    }
  })

  it('rejects empty, dot, slash, NUL and overlong names', () => {
    expect(nameProblem('')).toMatch(/empty/)
    expect(nameProblem('   ')).toMatch(/empty/)
    expect(nameProblem('.')).toMatch(/not a valid/)
    expect(nameProblem('..')).toMatch(/not a valid/)
    expect(nameProblem('a/b')).toMatch(/"\/"/)
    expect(nameProblem('a\0b')).toMatch(/null/)
    expect(nameProblem('x'.repeat(256))).toMatch(/too long/)
    expect(nameProblem('é'.repeat(128))).toMatch(/too long/) // 256 bytes
  })
})

describe('uniqueName', () => {
  it('numbers duplicates', () => {
    expect(uniqueName('New Folder', new Set())).toBe('New Folder')
    expect(uniqueName('New Folder', new Set(['New Folder']))).toBe('New Folder 2')
    expect(uniqueName('New Folder', new Set(['New Folder', 'New Folder 2']))).toBe('New Folder 3')
  })
})

describe('stemLength', () => {
  it('excludes the extension but keeps dotfiles whole', () => {
    expect(stemLength('report.pdf')).toBe(6)
    expect(stemLength('archive.tar.gz')).toBe(11)
    expect(stemLength('.bashrc')).toBe(7)
    expect(stemLength('Makefile')).toBe(8)
  })
})

describe('parseIdMap', () => {
  it('reads passwd/group style lines', () => {
    const map = parseIdMap(
      '# comment\nroot:x:0:0:root:/root:/bin/bash\n\nvdos:x:1000:1000::/home/vdos:/bin/sh\nbroken\nbad:x:abc:\n'
    )
    expect(map.get(0)).toBe('root')
    expect(map.get(1000)).toBe('vdos')
    expect(map.size).toBe(2)
  })

  it('keeps the first name for a duplicated id', () => {
    expect(parseIdMap('a:x:5:\nb:x:5:\n').get(5)).toBe('a')
  })
})
