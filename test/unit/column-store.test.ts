import { describe, expect, it } from 'vitest'
import { createColumnStore } from '../../src/renderer/src/features/column/columnStore'
import { fakeFs, file, folder, type Tree } from './fake-fs'

const tree = (): Tree => ({
  '/': [folder('/', 'home'), folder('/', 'etc')],
  '/home': [folder('/home', 'me')],
  '/home/me': [
    folder('/home/me', 'docs'),
    folder('/home/me', 'src'),
    file('/home/me', 'a.txt'),
    file('/home/me', 'b.txt'),
    file('/home/me', 'c.txt'),
    file('/home/me', '.secret')
  ],
  '/home/me/docs': [],
  '/home/me/src': [file('/home/me/src', 'main.ts')]
})

async function started(fs = fakeFs(tree())) {
  const store = createColumnStore({ machineId: 'local', fs, notify: () => {} })
  await store.getState().init()
  return { store, fs, s: () => store.getState() }
}

describe('navigation', () => {
  it('opens the home folder on init, hiding dotfiles and putting folders first', async () => {
    const { s } = await started()
    expect(s().cwd).toBe('/home/me')
    expect(s().visible.map((e) => e.name)).toEqual(['docs', 'src', 'a.txt', 'b.txt', 'c.txt'])
    expect(s().cursor).toBe('/home/me/docs')
  })

  it('opens folders and keeps history, with back/forward/up', async () => {
    const { s } = await started()
    await s().open(s().visible[1]!) // src
    expect(s().cwd).toBe('/home/me/src')
    await s().up()
    expect(s().cwd).toBe('/home/me')
    expect(s().cursor).toBe('/home/me/src') // landed on the folder we came from
    await s().back()
    expect(s().cwd).toBe('/home/me/src')
    await s().forward()
    expect(s().cwd).toBe('/home/me')
    expect(s().history).toEqual(['/home/me', '/home/me/src', '/home/me'])
  })

  it('drops forward history when navigating after going back', async () => {
    const { s } = await started()
    await s().navigate('src')
    await s().back()
    await s().navigate('docs')
    expect(s().history).toEqual(['/home/me', '/home/me/docs'])
    await s().forward()
    expect(s().cwd).toBe('/home/me/docs')
  })

  it('does not open plain files', async () => {
    const { s, fs } = await started()
    const before = fs.calls.length
    await s().open(s().visible.find((e) => e.name === 'a.txt')!)
    expect(fs.calls.length).toBe(before)
  })

  it('opens symlinks that point at folders', async () => {
    const t = tree()
    t['/home/me']!.push(file('/home/me', 'shortcut', { type: 'symlink', linkTargetType: 'dir' }))
    t['/home/me/shortcut'] = []
    const { s } = await started(fakeFs(t))
    await s().open(s().visible.find((e) => e.name === 'shortcut')!)
    expect(s().cwd).toBe('/home/me/shortcut')
  })

  it('resolves ~, relative and absolute typed paths', async () => {
    const { s } = await started()
    expect(await s().navigate('~/src')).toBe(true)
    expect(s().cwd).toBe('/home/me/src')
    await s().navigate('..')
    expect(s().cwd).toBe('/home/me')
    await s().navigate('/home')
    expect(s().cwd).toBe('/home')
  })

  it('cannot go up from the root', async () => {
    const { s, fs } = await started()
    await s().navigate('/')
    const before = fs.calls.length
    await s().up()
    expect(fs.calls.length).toBe(before)
  })

  it('stays on the current folder and reports the error when a listing fails', async () => {
    const { s } = await started()
    expect(await s().navigate('/nope')).toBe(false)
    expect(s().cwd).toBe('/home/me')
    expect(s().error).toMatchObject({ code: 'ENOENT' })
    expect(s().visible.length).toBeGreaterThan(0)
    expect(s().history).toEqual(['/home/me'])
    await s().navigate('src')
    expect(s().error).toBeNull()
  })

  it('ignores a slow listing that was overtaken by a newer one', async () => {
    let release!: () => void
    const slow = new Promise<void>((r) => (release = r))
    const { store, s } = await started(fakeFs(tree(), { '/home': slow }))
    const stale = store.getState().navigate('/home') // hangs
    await s().navigate('/home/me/src')
    release()
    expect(await stale).toBe(false)
    expect(s().cwd).toBe('/home/me/src')
  })
})

describe('refresh', () => {
  it('reloads and keeps the selection that still exists', async () => {
    const t = tree()
    const { s } = await started(fakeFs(t))
    s().selectOnly('/home/me/a.txt')
    s().toggleSelect('/home/me/b.txt')
    t['/home/me'] = t['/home/me']!.filter((e) => e.name !== 'b.txt').concat(
      file('/home/me', 'd.txt')
    )
    await s().refresh()
    expect([...s().selected]).toEqual(['/home/me/a.txt'])
    expect(s().visible.map((e) => e.name)).toContain('d.txt')
  })
})

describe('hidden files and sorting', () => {
  it('toggles dotfiles and drops hidden paths from the selection', async () => {
    const { s } = await started()
    s().toggleHidden()
    expect(s().visible.map((e) => e.name)).toContain('.secret')
    s().selectOnly('/home/me/.secret')
    s().toggleHidden()
    expect(s().selected.size).toBe(0)
    expect(s().visible.map((e) => e.name)).not.toContain('.secret')
  })

  it('sorts, flips direction on repeat, and starts size/date descending', async () => {
    const t = tree()
    t['/home/me'] = [
      file('/home/me', 'small', { size: 1 }),
      file('/home/me', 'big', { size: 100 }),
      file('/home/me', 'mid', { size: 50 })
    ]
    const { s } = await started(fakeFs(t))
    s().setSort('size')
    expect(s().sortDir).toBe('desc')
    expect(s().visible.map((e) => e.name)).toEqual(['big', 'mid', 'small'])
    s().setSort('size')
    expect(s().visible.map((e) => e.name)).toEqual(['small', 'mid', 'big'])
    s().setSort('name')
    expect(s().sortDir).toBe('asc')
    expect(s().visible.map((e) => e.name)).toEqual(['big', 'mid', 'small'])
  })
})

describe('selection and cursor', () => {
  const names = (s: () => { selected: ReadonlySet<string> }) =>
    [...s().selected].map((p) => p.split('/').pop()).sort()

  it('moves the cursor and selects only it', async () => {
    const { s } = await started()
    s().moveCursor(1, false)
    expect(s().cursor).toBe('/home/me/src')
    expect(names(s)).toEqual(['src'])
    s().moveCursor(-5, false)
    expect(s().cursor).toBe('/home/me/docs') // clamped
  })

  it('extends a range with shift and shrinks it again', async () => {
    const { s } = await started()
    s().selectOnly('/home/me/src')
    s().moveCursor(1, true)
    s().moveCursor(1, true)
    expect(names(s)).toEqual(['a.txt', 'b.txt', 'src'])
    s().moveCursor(-1, true)
    expect(names(s)).toEqual(['a.txt', 'src'])
    s().moveCursor(-2, true)
    expect(names(s)).toEqual(['docs', 'src'])
  })

  it('supports ctrl-toggle, shift-click ranges and select all', async () => {
    const { s } = await started()
    s().selectOnly('/home/me/a.txt')
    s().toggleSelect('/home/me/c.txt')
    expect(names(s)).toEqual(['a.txt', 'c.txt'])
    s().toggleSelect('/home/me/a.txt')
    expect(names(s)).toEqual(['c.txt'])
    s().selectOnly('/home/me/docs')
    s().selectRange('/home/me/b.txt')
    expect(names(s)).toEqual(['a.txt', 'b.txt', 'docs', 'src'])
    s().selectAll()
    expect(s().selected.size).toBe(5)
    s().clearSelection()
    expect(s().selected.size).toBe(0)
  })

  it('jumps to first and last', async () => {
    const { s } = await started()
    s().cursorTo('last', false)
    expect(s().cursor).toBe('/home/me/c.txt')
    s().cursorTo('first', true)
    expect(s().selected.size).toBe(5)
  })

  it('opens the folder under the cursor with Enter', async () => {
    const { s } = await started()
    s().moveCursor(1, false)
    await s().openCursor()
    expect(s().cwd).toBe('/home/me/src')
  })

  it('handles empty folders', async () => {
    const { s } = await started()
    await s().navigate('docs')
    s().moveCursor(1, false)
    s().cursorTo('last', true)
    expect(s().cursor).toBeNull()
    expect(s().selected.size).toBe(0)
  })
})
