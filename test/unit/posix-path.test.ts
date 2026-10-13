import { describe, expect, it } from 'vitest'
import {
  baseName,
  breadcrumbs,
  joinPath,
  normalizePath,
  parentOf,
  resolveInput
} from '@shared/posix-path'

describe('posix-path', () => {
  it('normalizes dots and slashes', () => {
    expect(normalizePath('/a//b/./c/../d/')).toBe('/a/b/d')
    expect(normalizePath('/..')).toBe('/')
    expect(normalizePath('/')).toBe('/')
  })

  it('joins and splits', () => {
    expect(joinPath('/', 'etc')).toBe('/etc')
    expect(joinPath('/etc', 'hosts')).toBe('/etc/hosts')
    expect(parentOf('/etc/hosts')).toBe('/etc')
    expect(parentOf('/etc')).toBe('/')
    expect(parentOf('/')).toBe('/')
    expect(baseName('/etc/hosts')).toBe('hosts')
    expect(baseName('/')).toBe('/')
  })

  it('builds breadcrumbs', () => {
    expect(breadcrumbs('/')).toEqual([{ name: '/', path: '/' }])
    expect(breadcrumbs('/a/b')).toEqual([
      { name: '/', path: '/' },
      { name: 'a', path: '/a' },
      { name: 'b', path: '/a/b' }
    ])
  })

  it('resolves typed input against home and cwd', () => {
    expect(resolveInput('~', '/x', '/home/me')).toBe('/home/me')
    expect(resolveInput('~/code', '/x', '/home/me')).toBe('/home/me/code')
    expect(resolveInput('/etc/', '/x', '/home/me')).toBe('/etc')
    expect(resolveInput('sub/dir', '/x', '/home/me')).toBe('/x/sub/dir')
    expect(resolveInput('../y', '/x/z', '/home/me')).toBe('/x/y')
    expect(resolveInput('  /tmp  ', '/x', '/home/me')).toBe('/tmp')
  })
})
