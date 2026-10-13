import { describe, expect, it, vi } from 'vitest'
import { createColumnStore } from '../../src/renderer/src/features/column/columnStore'
import type { Notification } from '../../src/renderer/src/lib/toasts'
import { fakeFs, file, folder, type Tree } from './fake-fs'

const tree = (): Tree => ({
  '/': [folder('/', 'home')],
  '/home': [folder('/home', 'me')],
  '/home/me': [
    folder('/home/me', 'docs'),
    file('/home/me', 'a.txt'),
    file('/home/me', 'b.txt'),
    file('/home/me', 'c.txt')
  ],
  '/home/me/docs': [file('/home/me/docs', 'inner.txt')]
})

async function started(fs = fakeFs(tree())) {
  const notes: Notification[] = []
  const store = createColumnStore({
    machineId: 'local',
    fs,
    notify: (n) => notes.push(n),
    watchKey: 'col-1'
  })
  await store.getState().init()
  return { store, fs, notes, s: () => store.getState() }
}
const names = (s: () => { visible: { name: string }[] }) => s().visible.map((e) => e.name)

describe('create', () => {
  it('makes "New Folder", selects it and starts renaming', async () => {
    const { s, fs } = await started()
    await s().create('folder')
    expect(fs.ops).toEqual(['mkdir /home/me/New Folder'])
    expect(s().cursor).toBe('/home/me/New Folder')
    expect([...s().selected]).toEqual(['/home/me/New Folder'])
    expect(s().renaming).toBe('/home/me/New Folder')
    expect(names(s)).toContain('New Folder')
  })

  it('numbers new names when one is already taken', async () => {
    const { s } = await started()
    await s().create('folder')
    s().cancelRename()
    await s().create('folder')
    expect(s().renaming).toBe('/home/me/New Folder 2')
    await s().create('file')
    expect(s().renaming).toBe('/home/me/New File')
  })

  it('takes the next name when another process wins the race', async () => {
    const t = tree()
    const fs = fakeFs(t)
    const { s } = await started(fs)
    // A file appears after the listing, so the column doesn't know about it.
    t['/home/me']!.push(file('/home/me', 'New File'))
    await s().create('file')
    expect(s().renaming).toBe('/home/me/New File 2')
  })

  it('reports failures instead of throwing', async () => {
    const { s, notes, fs } = await started()
    fs.mkdir = async () => {
      throw Object.assign(new Error('x'), { message: 'Permission denied for "/home/me"' })
    }
    await s().create('folder')
    expect(notes).toEqual([{ kind: 'error', message: 'Permission denied for "/home/me"' }])
    expect(s().renaming).toBeNull()
  })
})

describe('rename', () => {
  it('renames through F2 flow and keeps the item selected under its new name', async () => {
    const { s, fs } = await started()
    s().startRename('/home/me/a.txt')
    expect(s().renaming).toBe('/home/me/a.txt')
    expect(await s().commitRename('z.txt')).toBe(true)
    expect(fs.ops).toEqual(['rename /home/me/a.txt /home/me/z.txt'])
    expect(s().renaming).toBeNull()
    expect(s().cursor).toBe('/home/me/z.txt')
    expect(names(s)).toEqual(['docs', 'b.txt', 'c.txt', 'z.txt'])
  })

  it('treats an unchanged name as a cancel', async () => {
    const { s, fs } = await started()
    s().startRename('/home/me/a.txt')
    expect(await s().commitRename('a.txt')).toBe(true)
    expect(s().renaming).toBeNull()
    expect(fs.ops).toEqual([])
  })

  it('rejects invalid and duplicate names but stays in rename mode', async () => {
    const { s, notes, fs } = await started()
    s().startRename('/home/me/a.txt')
    expect(await s().commitRename('')).toBe(false)
    expect(await s().commitRename('x/y')).toBe(false)
    expect(await s().commitRename('b.txt')).toBe(false)
    expect(notes.map((n) => n.message)).toEqual([
      'Name cannot be empty',
      'Name cannot contain "/"',
      '"b.txt" already exists'
    ])
    expect(s().renaming).toBe('/home/me/a.txt')
    expect(fs.ops).toEqual([])
  })

  it('stops renaming and refreshes when the machine refuses', async () => {
    const { s, notes, fs } = await started()
    s().startRename('/home/me/a.txt')
    // Someone else removed the file in the meantime.
    fs.tree['/home/me'] = fs.tree['/home/me']!.filter((e) => e.name !== 'a.txt')
    expect(await s().commitRename('z.txt')).toBe(false)
    expect(notes[0]?.kind).toBe('error')
    expect(s().renaming).toBeNull()
    expect(names(s)).not.toContain('a.txt')
  })

  it('ignores startRename for paths that are not listed', async () => {
    const { s } = await started()
    s().startRename('/home/me/ghost')
    expect(s().renaming).toBeNull()
  })

  it('drops the rename when the item disappears on refresh', async () => {
    const { s, fs } = await started()
    s().startRename('/home/me/a.txt')
    fs.tree['/home/me'] = fs.tree['/home/me']!.filter((e) => e.name !== 'a.txt')
    await s().refresh()
    expect(s().renaming).toBeNull()
  })
})

describe('remove', () => {
  it('moves the selection to the trash and lands on the next item', async () => {
    const { s, fs } = await started()
    s().selectOnly('/home/me/a.txt')
    await s().remove(['/home/me/a.txt'], { permanent: false })
    expect(fs.ops).toEqual(['remove /home/me/a.txt (trash)'])
    expect(names(s)).toEqual(['docs', 'b.txt', 'c.txt'])
    expect(s().cursor).toBe('/home/me/b.txt')
    expect([...s().selected]).toEqual(['/home/me/b.txt'])
  })

  it('lands on the previous item when the last one is removed', async () => {
    const { s } = await started()
    s().selectOnly('/home/me/c.txt')
    await s().remove(['/home/me/c.txt'], { permanent: true })
    expect(s().cursor).toBe('/home/me/b.txt')
  })

  it('deletes several items permanently', async () => {
    const { s, fs } = await started()
    await s().remove(['/home/me/a.txt', '/home/me/docs'], { permanent: true })
    expect(fs.ops).toEqual(['remove /home/me/a.txt', 'remove /home/me/docs'])
    expect(names(s)).toEqual(['b.txt', 'c.txt'])
  })

  it('reports trash failures and keeps the files', async () => {
    const { s, notes, fs } = await started()
    fs.failTrash = true
    await s().remove(['/home/me/a.txt'], { permanent: false })
    expect(notes).toEqual([{ kind: 'error', message: 'Could not move "a.txt" to the Trash' }])
    expect(names(s)).toContain('a.txt')
  })

  it('keeps going after a failure and summarizes', async () => {
    const { s, notes, fs } = await started()
    fs.tree['/home/me'] = fs.tree['/home/me']!.filter((e) => e.name !== 'a.txt')
    await s().remove(['/home/me/a.txt', '/home/me/b.txt', '/home/me/c.txt'], { permanent: true })
    expect(fs.ops).toHaveLength(3)
    expect(names(s)).toEqual(['docs'])
    expect(notes).toHaveLength(1)
    expect(notes[0]!.message).toMatch(/^Could not delete 1 of 3 items: /)
  })

  it('does nothing for an empty list', async () => {
    const { s, fs } = await started()
    await s().remove([], { permanent: true })
    expect(fs.ops).toEqual([])
  })
})

describe('chmod and details', () => {
  it('applies a mode to every path and refreshes the list', async () => {
    const { s, fs } = await started()
    await s().chmod(['/home/me/a.txt', '/home/me/b.txt'], 0o600)
    expect(fs.ops).toEqual(['chmod /home/me/a.txt 600', 'chmod /home/me/b.txt 600'])
    expect(s().visible.find((e) => e.name === 'a.txt')?.mode).toBe(0o600)
  })

  it('reports failures', async () => {
    const { s, notes, fs } = await started()
    fs.tree['/home/me'] = fs.tree['/home/me']!.filter((e) => e.name !== 'a.txt')
    await s().chmod(['/home/me/a.txt'], 0o600)
    expect(notes[0]?.kind).toBe('error')
  })

  it('fetches details for the properties dialog', async () => {
    const { s } = await started()
    expect(await s().details('/home/me/a.txt')).toMatchObject({ owner: 'me', uid: 1000 })
  })

  it('lists the selected entries in list order', async () => {
    const { s } = await started()
    s().selectOnly('/home/me/c.txt')
    s().toggleSelect('/home/me/a.txt')
    expect(
      s()
        .selectedEntries()
        .map((e) => e.name)
    ).toEqual(['a.txt', 'c.txt'])
  })
})

describe('live updates', () => {
  it('watches the folder it shows, and re-watches after navigating', async () => {
    const { s, fs } = await started()
    expect(fs.watched).toEqual([{ path: '/home/me', key: 'col-1' }])
    await s().navigate('docs')
    expect(fs.watched.at(-1)).toEqual({ path: '/home/me/docs', key: 'col-1' })
  })

  it('does not re-watch on refresh of the same folder', async () => {
    const { s, fs } = await started()
    await s().refresh()
    expect(fs.watched).toHaveLength(1)
  })

  it('refreshes when its own key changes, and ignores other columns', async () => {
    const { s, fs } = await started()
    fs.tree['/home/me']!.push(file('/home/me', 'new.txt'))
    fs.emitChanged('some-other-column')
    await vi.waitFor(() => expect(fs.calls.length).toBe(1))
    expect(names(s)).not.toContain('new.txt')
    fs.emitChanged('col-1')
    await vi.waitFor(() => expect(names(s)).toContain('new.txt'))
  })

  it('keeps the selection across a watcher refresh', async () => {
    const { s, fs } = await started()
    s().selectOnly('/home/me/b.txt')
    fs.tree['/home/me']!.push(file('/home/me', 'new.txt'))
    fs.emitChanged('col-1')
    await vi.waitFor(() => expect(names(s)).toContain('new.txt'))
    expect([...s().selected]).toEqual(['/home/me/b.txt'])
  })

  it('moves up to the nearest existing folder when the current one is deleted', async () => {
    const { s, fs, notes } = await started()
    await s().navigate('docs')
    delete fs.tree['/home/me/docs']
    fs.tree['/home/me'] = fs.tree['/home/me']!.filter((e) => e.name !== 'docs')
    fs.emitChanged('col-1')
    await vi.waitFor(() => expect(s().cwd).toBe('/home/me'))
    expect(s().error).toBeNull()
    expect(notes).toEqual([
      { kind: 'info', message: '"/home/me/docs" no longer exists; moved to "/home/me"' }
    ])
  })

  it('climbs past several missing ancestors', async () => {
    const { s, fs } = await started()
    await s().navigate('docs')
    delete fs.tree['/home/me/docs']
    delete fs.tree['/home/me']
    await s().refresh()
    expect(s().cwd).toBe('/home')
  })

  it('stops listening and unwatches on dispose', async () => {
    const { s, fs } = await started()
    s().dispose()
    expect(fs.unwatched).toEqual(['col-1'])
    fs.tree['/home/me']!.push(file('/home/me', 'late.txt'))
    fs.emitChanged('col-1')
    await new Promise((r) => setTimeout(r, 20))
    expect(names(s)).not.toContain('late.txt')
  })
})
