import { describe, expect, it } from 'vitest'
import {
  hasBit,
  modeToOctal,
  parseOctal,
  toggleBit
} from '../../src/renderer/src/features/column/mode'
import { describeType, formatDateTime } from '../../src/renderer/src/features/column/format'

describe('mode helpers', () => {
  it('formats octal, adding a digit only for special bits', () => {
    expect(modeToOctal(0o644)).toBe('644')
    expect(modeToOctal(0o7)).toBe('007')
    expect(modeToOctal(0o2755)).toBe('2755')
    expect(modeToOctal(0o1000)).toBe('1000')
  })

  it('parses only valid octal modes', () => {
    expect(parseOctal('644')).toBe(0o644)
    expect(parseOctal(' 2755 ')).toBe(0o2755)
    expect(parseOctal('0')).toBe(0)
    for (const bad of ['', '8', '12345', '-1', 'rwx', '6 4']) expect(parseOctal(bad)).toBeNull()
  })

  it('reads and toggles single bits without disturbing the others', () => {
    expect(hasBit(0o644, 'ownerWrite')).toBe(true)
    expect(hasBit(0o644, 'groupWrite')).toBe(false)
    expect(toggleBit(0o644, 'groupWrite')).toBe(0o664)
    expect(toggleBit(0o664, 'groupWrite')).toBe(0o644)
    expect(toggleBit(0o755, 'setuid')).toBe(0o4755)
    expect(hasBit(0o1777, 'sticky')).toBe(true)
  })
})

describe('describeType / formatDateTime', () => {
  it('names entry kinds', () => {
    expect(describeType({ type: 'file' })).toBe('File')
    expect(describeType({ type: 'dir' })).toBe('Folder')
    expect(describeType({ type: 'other' })).toBe('Special file')
    expect(describeType({ type: 'symlink', linkTargetType: 'dir' })).toBe(
      'Symbolic link to a folder'
    )
    expect(describeType({ type: 'symlink', linkTargetType: 'file' })).toBe(
      'Symbolic link to a file'
    )
    expect(describeType({ type: 'symlink', linkTargetType: 'broken' })).toBe('Broken symbolic link')
  })

  it('shows a dash for unknown times', () => {
    expect(formatDateTime(0)).toBe('—')
    expect(formatDateTime(1_700_000_000_000)).toMatch(/2023/)
  })
})
