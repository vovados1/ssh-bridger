import { chmod, lstat, mkdir, readFile, readlink, readdir, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { FsError, type MachineId } from '@shared/fs-types'
import type { TransferMode, TransferRequest } from '@shared/transfers'
import {
  FakeRemote,
  harness,
  listTree,
  makeTree,
  read,
  slowReads,
  trackWrites,
  type Harness
} from '../helpers/transfer-harness'
import { LocalProvider } from '../../src/main/fs/local-provider'

let h: Harness
afterEach(() => h?.cleanup())

const req = (
  h: Harness,
  src: { machine: MachineId; paths: string[] },
  dest: { machine: MachineId; dir: string },
  mode: TransferMode = 'copy'
): TransferRequest => ({
  source: { machineId: src.machine, paths: src.paths },
  dest: { machineId: dest.machine, dir: dest.dir },
  mode
})

/** Most tests copy from `local` to the fake remote machine, so the streaming path is used. */
async function setup(options: Parameters<typeof harness>[0] = {}) {
  h = await harness(options)
  const src = join(h.root, 'src')
  const dst = join(h.root, 'dst')
  await mkdir(src)
  await mkdir(dst)
  const copy = (names: string[], mode: TransferMode = 'copy') =>
    h.run(
      req(
        h,
        { machine: 'local', paths: names.map((n) => join(src, n)) },
        { machine: 'ssh:fake', dir: dst },
        mode
      )
    )
  return { src, dst, copy }
}

describe('copying files', () => {
  it('copies a file with its content, permissions and modification time, leaving the source', async () => {
    const { src, dst, copy } = await setup()
    await makeTree(src, { 'report.txt': 'hello world' })
    await chmod(join(src, 'report.txt'), 0o640)
    const when = new Date('2021-03-04T05:06:07Z')
    await utimes(join(src, 'report.txt'), when, when)

    const job = await copy(['report.txt'])

    expect(job).toMatchObject({
      status: 'done',
      filesTotal: 1,
      filesDone: 1,
      bytesTotal: 11,
      bytesDone: 11,
      errorCount: 0
    })
    expect(await read(join(dst, 'report.txt'))).toBe('hello world')
    expect((await stat(join(dst, 'report.txt'))).mode & 0o7777).toBe(0o640)
    expect(Math.abs((await stat(join(dst, 'report.txt'))).mtimeMs - when.getTime())).toBeLessThan(
      1500
    )
    expect(await read(join(src, 'report.txt'))).toBe('hello world') // copy leaves the source alone
  })

  it('never leaves a temporary file behind, and the final name only appears when complete', async () => {
    const { src, dst, copy } = await setup()
    await makeTree(src, { 'a.bin': 'x'.repeat(100_000) })
    await copy(['a.bin'])
    expect(await readdir(dst)).toEqual(['a.bin'])
  })

  it('copies empty files and large files exactly', async () => {
    const { src, dst, copy } = await setup()
    const big = randomBytes(6 * 1024 * 1024 + 7)
    await makeTree(src, { empty: '' })
    await (await import('node:fs/promises')).writeFile(join(src, 'big.bin'), big)
    const job = await copy(['empty', 'big.bin'])
    expect(job.status).toBe('done')
    expect((await stat(join(dst, 'empty'))).size).toBe(0)
    expect(Buffer.compare(await readFile(join(dst, 'big.bin')), big)).toBe(0)
    expect(job.bytesTotal).toBe(big.length)
  })

  it('copies folder trees: nested folders, empty folders, dotfiles and symlinks', async () => {
    const { src, dst, copy } = await setup()
    await makeTree(src, {
      'proj/readme.md': '# hi',
      'proj/.env': 'SECRET=1',
      'proj/src/deep/er/file.ts': 'code',
      'proj/empty/': null,
      'proj/src/a.ts': 'a'
    })
    await (await import('node:fs/promises')).symlink('readme.md', join(src, 'proj/link'))
    await (await import('node:fs/promises')).symlink('/nonexistent', join(src, 'proj/dangling'))

    const job = await copy(['proj'])
    expect(job).toMatchObject({ status: 'done', errorCount: 0 })
    expect(await listTree(join(dst, 'proj'))).toEqual(await listTree(join(src, 'proj')))
    expect((await lstat(join(dst, 'proj/link'))).isSymbolicLink()).toBe(true)
    expect(await readlink(join(dst, 'proj/link'))).toBe('readme.md')
    expect(await readlink(join(dst, 'proj/dangling'))).toBe('/nonexistent')
    expect(await read(join(dst, 'proj/.env'))).toBe('SECRET=1')
    expect(job.filesTotal).toBe(job.filesDone)
    expect(job.filesDone).toBe(6) // five files + two links - well, counted below
  })

  it('applies folder permissions after their contents, so read-only folders can be filled', async () => {
    const { src, dst, copy } = await setup()
    await makeTree(src, { 'locked/inside.txt': 'x' })
    const when = new Date('2019-01-02T03:04:05Z')
    await utimes(join(src, 'locked'), when, when)
    await chmod(join(src, 'locked'), 0o555)
    try {
      const job = await copy(['locked'])
      expect(job.status).toBe('done')
      expect((await stat(join(dst, 'locked'))).mode & 0o777).toBe(0o555)
      expect(await read(join(dst, 'locked/inside.txt'))).toBe('x')
      // The folder's own time is set last, so adding files did not disturb it.
      expect(Math.abs((await stat(join(dst, 'locked'))).mtimeMs - when.getTime())).toBeLessThan(
        1500
      )
    } finally {
      await chmod(join(src, 'locked'), 0o755)
      await chmod(join(dst, 'locked'), 0o755)
    }
  })

  it('copies several sources in one job', async () => {
    const { src, dst, copy } = await setup()
    await makeTree(src, { 'a.txt': 'A', 'b.txt': 'BB', 'd/c.txt': 'CCC' })
    const job = await copy(['a.txt', 'b.txt', 'd'])
    expect(job).toMatchObject({ status: 'done', filesTotal: 3, bytesTotal: 6 })
    expect(await listTree(dst)).toEqual(['a.txt', 'b.txt', 'd/', 'd/c.txt'])
  })

  it('copies between two paths of the same machine through the same code', async () => {
    h = await harness()
    await makeTree(join(h.root), { 'one/f.txt': 'F', 'two/': null })
    const job = await h.run(
      req(
        h,
        { machine: 'local', paths: [join(h.root, 'one/f.txt')] },
        { machine: 'local', dir: join(h.root, 'two') }
      )
    )
    expect(job.status).toBe('done')
    expect(await read(join(h.root, 'two/f.txt'))).toBe('F')
    expect(await read(join(h.root, 'one/f.txt'))).toBe('F')
  })

  it('does not preserve attributes when told not to', async () => {
    const { src, dst, copy } = await setup({ preserveAttributes: false })
    await makeTree(src, { 'f.txt': 'x' })
    await chmod(join(src, 'f.txt'), 0o600)
    await utimes(join(src, 'f.txt'), new Date('2001-01-01'), new Date('2001-01-01'))
    await copy(['f.txt'])
    expect((await stat(join(dst, 'f.txt'))).mode & 0o777).toBe(0o644)
    expect((await stat(join(dst, 'f.txt'))).mtime.getFullYear()).toBeGreaterThan(2020)
  })
})

describe('starting a job', () => {
  it('rejects a destination that is missing or not a folder', async () => {
    const { src, dst } = await setup()
    await makeTree(src, { 'f.txt': 'x', plain: 'file' })
    await expect(
      h.mgr.start(
        req(
          h,
          { machine: 'local', paths: [join(src, 'f.txt')] },
          { machine: 'ssh:fake', dir: join(dst, 'nope') }
        )
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      h.mgr.start(
        req(
          h,
          { machine: 'local', paths: [join(src, 'f.txt')] },
          { machine: 'ssh:fake', dir: join(src, 'plain') }
        )
      )
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('rejects an unknown or disconnected machine immediately', async () => {
    const { src, dst } = await setup()
    await expect(
      h.mgr.start(
        req(h, { machine: 'ssh:gone', paths: [join(src, 'f')] }, { machine: 'local', dir: dst })
      )
    ).rejects.toThrow()
  })

  it('records a missing source as an error and still copies the rest', async () => {
    const { src, copy } = await setup()
    await makeTree(src, { 'real.txt': 'ok' })
    const job = await copy(['missing.txt', 'real.txt'])
    expect(job.status).toBe('error')
    expect(job.errorCount).toBe(1)
    expect(job.errors[0]).toMatchObject({ path: join(src, 'missing.txt') })
    expect(job.filesDone).toBe(1)
  })

  it('refuses to copy or move a folder into itself or its own subfolder', async () => {
    h = await harness()
    await makeTree(h.root, { 'a/b/': null })
    for (const mode of ['copy', 'move'] as const) {
      for (const dest of ['a', 'a/b']) {
        const job = await h.run(
          req(
            h,
            { machine: 'local', paths: [join(h.root, 'a')] },
            { machine: 'local', dir: join(h.root, dest) },
            mode
          )
        )
        expect(job.status).toBe('error')
        expect(job.errors[0]!.message).toMatch(/into itself/)
      }
    }
    expect(await listTree(h.root)).toEqual(['a/', 'a/b/'])
  })

  it('makes a "(copy)" instead of overwriting when a file is copied onto itself', async () => {
    h = await harness()
    await makeTree(h.root, { 'dir/report.pdf': 'DATA' })
    const job = await h.run(
      req(
        h,
        { machine: 'local', paths: [join(h.root, 'dir/report.pdf')] },
        { machine: 'local', dir: join(h.root, 'dir') }
      )
    )
    expect(job.status).toBe('done')
    expect(h.conflicts).toHaveLength(0) // no question: overwriting yourself is never an option
    expect(await listTree(join(h.root, 'dir'))).toEqual(['report (copy).pdf', 'report.pdf'])
    expect(await read(join(h.root, 'dir/report.pdf'))).toBe('DATA')
  })
})

describe('conflicts', () => {
  async function conflictSetup() {
    const s = await setup()
    await makeTree(s.src, { 'a.txt': 'NEW-A', 'b.txt': 'NEW-B', 'c.txt': 'NEW-C' })
    await makeTree(s.dst, { 'a.txt': 'old-a', 'b.txt': 'old-b' })
    return s
  }

  it('asks, shows both versions, and overwrites on request', async () => {
    const { src, dst, copy } = await conflictSetup()
    h.autoAnswer([
      { resolution: 'overwrite', applyToAll: false },
      { resolution: 'overwrite', applyToAll: false }
    ])
    const job = await copy(['a.txt', 'b.txt'])
    expect(job.status).toBe('done')
    expect(h.conflicts).toHaveLength(2)
    expect(h.conflicts[0]).toMatchObject({
      kind: 'file',
      name: 'a.txt',
      destMachineId: 'ssh:fake',
      src: { path: join(src, 'a.txt'), size: 5 },
      dst: { path: join(dst, 'a.txt'), size: 5 }
    })
    expect(await read(join(dst, 'a.txt'))).toBe('NEW-A')
    expect(await read(join(dst, 'b.txt'))).toBe('NEW-B')
    expect(await readdir(dst)).not.toContain(expect.stringContaining('.sshbridger-part'))
  })

  it('skips on request, leaving the destination untouched and the totals consistent', async () => {
    const { dst, copy } = await conflictSetup()
    h.autoAnswer([{ resolution: 'skip', applyToAll: true }])
    const job = await copy(['a.txt', 'b.txt', 'c.txt'])
    expect(await read(join(dst, 'a.txt'))).toBe('old-a')
    expect(await read(join(dst, 'b.txt'))).toBe('old-b')
    expect(await read(join(dst, 'c.txt'))).toBe('NEW-C')
    expect(job).toMatchObject({ status: 'done', skipped: 2, filesTotal: 1, filesDone: 1 })
    expect(job.bytesDone).toBe(job.bytesTotal)
  })

  it('keeps both under a new name', async () => {
    const { dst, copy } = await conflictSetup()
    h.autoAnswer([{ resolution: 'keepBoth', applyToAll: false }])
    await copy(['a.txt'])
    expect(await read(join(dst, 'a.txt'))).toBe('old-a')
    expect(await read(join(dst, 'a (copy).txt'))).toBe('NEW-A')
  })

  it('numbers repeated copies', async () => {
    const { dst, copy } = await conflictSetup()
    await makeTree(dst, { 'a (copy).txt': 'earlier copy' })
    h.autoAnswer([{ resolution: 'keepBoth', applyToAll: false }])
    await copy(['a.txt'])
    expect(await read(join(dst, 'a (copy 2).txt'))).toBe('NEW-A')
    expect(await read(join(dst, 'a (copy).txt'))).toBe('earlier copy')
  })

  it('overwrites only when the source is newer ("overwrite if newer")', async () => {
    const { src, dst, copy } = await conflictSetup()
    await utimes(join(src, 'a.txt'), new Date('2030-01-01'), new Date('2030-01-01')) // newer
    await utimes(join(src, 'b.txt'), new Date('2000-01-01'), new Date('2000-01-01')) // older
    h.autoAnswer([{ resolution: 'overwriteIfNewer', applyToAll: true }])
    const job = await copy(['a.txt', 'b.txt'])
    expect(await read(join(dst, 'a.txt'))).toBe('NEW-A')
    expect(await read(join(dst, 'b.txt'))).toBe('old-b')
    expect(job.skipped).toBe(1)
  })

  it('asks once and reuses the answer when "apply to all" is set', async () => {
    const { dst, copy } = await conflictSetup()
    h.autoAnswer([{ resolution: 'overwrite', applyToAll: true }])
    await copy(['a.txt', 'b.txt', 'c.txt'])
    expect(h.conflicts).toHaveLength(1)
    expect(await read(join(dst, 'b.txt'))).toBe('NEW-B')
  })

  it('pauses the job while a question is open and resumes after the answer', async () => {
    const { copy } = await conflictSetup()
    const id = await h.mgr.start(
      req(
        h,
        { machine: 'local', paths: [join(h.root, 'src/a.txt')] },
        { machine: 'ssh:fake', dir: join(h.root, 'dst') }
      )
    )
    const waiting = await h.waitFor(id, (j) => j.status === 'waiting')
    expect(h.conflicts).toHaveLength(1)
    expect(waiting.filesDone).toBe(0)
    h.mgr.resolveConflict(h.conflicts[0]!.id, { resolution: 'skip', applyToAll: false })
    const done = await h.waitFor(id, (j) => j.status === 'done')
    expect(done.skipped).toBe(1)
    void copy
  })

  it('merges a folder into an existing one and only asks about files that really collide', async () => {
    const { src, dst, copy } = await setup()
    await makeTree(src, { 'proj/same.txt': 'NEW', 'proj/only-src.txt': 'S', 'proj/sub/x.txt': 'X' })
    await makeTree(dst, { 'proj/same.txt': 'old', 'proj/only-dst.txt': 'D' })
    h.autoAnswer([{ resolution: 'overwrite', applyToAll: false }])
    const job = await copy(['proj'])
    expect(job.status).toBe('done')
    expect(h.conflicts.map((c) => c.name)).toEqual(['same.txt'])
    expect(await listTree(join(dst, 'proj'))).toEqual([
      'only-dst.txt',
      'only-src.txt',
      'same.txt',
      'sub/',
      'sub/x.txt'
    ])
    expect(await read(join(dst, 'proj/same.txt'))).toBe('NEW')
  })

  it('treats a file where a folder is a type mismatch: replace is not offered as an applyToAll answer', async () => {
    const { src, dst, copy } = await setup()
    await makeTree(src, { thing: 'I am a file', other: 'file2' })
    await makeTree(dst, { 'thing/inside.txt': 'x', 'other/inside.txt': 'y' })
    h.autoAnswer([
      { resolution: 'overwrite', applyToAll: true }, // would be dangerous for a folder
      { resolution: 'skip', applyToAll: false }
    ])
    const job = await copy(['thing', 'other'])
    expect(h.conflicts.map((c) => c.kind)).toEqual(['type-mismatch', 'type-mismatch'])
    expect((await lstat(join(dst, 'thing'))).isDirectory()).toBe(true)
    expect(job.skipped).toBe(2)
  })

  it('keeps both for a folder in the way, renaming the whole incoming folder', async () => {
    const { src, dst, copy } = await setup()
    await makeTree(src, { x: 'file named x' })
    await makeTree(dst, { 'x/old.txt': 'old' })
    h.autoAnswer([{ resolution: 'keepBoth', applyToAll: false }])
    await copy(['x'])
    expect(await read(join(dst, 'x (copy)'))).toBe('file named x')
    expect(await read(join(dst, 'x/old.txt'))).toBe('old')
  })

  it('cancelling a job that is waiting on a question closes the question', async () => {
    const { src, dst } = await conflictSetup()
    const id = await h.mgr.start(
      req(h, { machine: 'local', paths: [join(src, 'a.txt')] }, { machine: 'ssh:fake', dir: dst })
    )
    await h.waitFor(id, (j) => j.status === 'waiting')
    h.mgr.cancel(id)
    const job = await h.waitFor(id, (j) => j.status === 'cancelled')
    expect(job.status).toBe('cancelled')
    expect(h.cancelledConflicts).toEqual([h.conflicts[0]!.id])
    expect(await read(join(dst, 'a.txt'))).toBe('old-a')
  })
})

describe('moving', () => {
  it('moves a file within one machine by renaming it', async () => {
    h = await harness()
    await makeTree(h.root, { 'a/f.txt': 'F', 'b/': null })
    const before = (await stat(join(h.root, 'a/f.txt'))).ino
    const job = await h.run(
      req(
        h,
        { machine: 'local', paths: [join(h.root, 'a/f.txt')] },
        { machine: 'local', dir: join(h.root, 'b') },
        'move'
      )
    )
    expect(job).toMatchObject({ status: 'done', filesDone: 1, filesTotal: 1 })
    expect(await listTree(h.root)).toEqual(['a/', 'b/', 'b/f.txt'])
    expect((await stat(join(h.root, 'b/f.txt'))).ino).toBe(before) // a rename, not a copy
  })

  it('moves a whole folder in one rename and credits all of its files', async () => {
    h = await harness()
    await makeTree(h.root, { 'a/proj/x.txt': 'XX', 'a/proj/sub/y.txt': 'YYY', 'b/': null })
    const job = await h.run(
      req(
        h,
        { machine: 'local', paths: [join(h.root, 'a/proj')] },
        { machine: 'local', dir: join(h.root, 'b') },
        'move'
      )
    )
    expect(job).toMatchObject({
      status: 'done',
      filesTotal: 2,
      filesDone: 2,
      bytesTotal: 5,
      bytesDone: 5
    })
    expect(await listTree(h.root)).toEqual([
      'a/',
      'b/',
      'b/proj/',
      'b/proj/sub/',
      'b/proj/sub/y.txt',
      'b/proj/x.txt'
    ])
  })

  it('treats moving into the folder it is already in as nothing to do', async () => {
    h = await harness()
    await makeTree(h.root, { 'a/f.txt': 'F' })
    const job = await h.run(
      req(
        h,
        { machine: 'local', paths: [join(h.root, 'a/f.txt')] },
        { machine: 'local', dir: join(h.root, 'a') },
        'move'
      )
    )
    expect(job).toMatchObject({ status: 'done', skipped: 1 })
    expect(await listTree(h.root)).toEqual(['a/', 'a/f.txt'])
  })

  it('merges a moved folder into an existing one, asking about collisions, then removes the emptied source', async () => {
    h = await harness()
    await makeTree(h.root, {
      'a/proj/new.txt': 'N',
      'a/proj/clash.txt': 'FROM-A',
      'b/proj/clash.txt': 'IN-B',
      'b/proj/keep.txt': 'K'
    })
    h.autoAnswer([{ resolution: 'overwrite', applyToAll: false }])
    const job = await h.run(
      req(
        h,
        { machine: 'local', paths: [join(h.root, 'a/proj')] },
        { machine: 'local', dir: join(h.root, 'b') },
        'move'
      )
    )
    expect(job.status).toBe('done')
    expect(await listTree(h.root)).toEqual([
      'a/',
      'b/',
      'b/proj/',
      'b/proj/clash.txt',
      'b/proj/keep.txt',
      'b/proj/new.txt'
    ])
    expect(await read(join(h.root, 'b/proj/clash.txt'))).toBe('FROM-A')
  })

  it('keeps a skipped file, and its folder, at the source', async () => {
    h = await harness()
    await makeTree(h.root, {
      'a/proj/new.txt': 'N',
      'a/proj/clash.txt': 'FROM-A',
      'b/proj/clash.txt': 'IN-B'
    })
    h.autoAnswer([{ resolution: 'skip', applyToAll: false }])
    await h.run(
      req(
        h,
        { machine: 'local', paths: [join(h.root, 'a/proj')] },
        { machine: 'local', dir: join(h.root, 'b') },
        'move'
      )
    )
    expect(await listTree(h.root)).toEqual([
      'a/',
      'a/proj/',
      'a/proj/clash.txt',
      'b/',
      'b/proj/',
      'b/proj/clash.txt',
      'b/proj/new.txt'
    ])
    expect(await read(join(h.root, 'b/proj/clash.txt'))).toBe('IN-B')
  })

  it('moves across machines by copying, verifying, then deleting each source file and emptied folders', async () => {
    const { src, dst, copy } = await setup()
    await makeTree(src, { 'proj/a.txt': 'A', 'proj/sub/b.txt': 'BB', 'solo.txt': 'S' })
    const job = await copy(['proj', 'solo.txt'], 'move')
    expect(job).toMatchObject({ status: 'done', filesDone: 3, errorCount: 0 })
    expect(await listTree(src)).toEqual([])
    expect(await listTree(dst)).toEqual([
      'proj/',
      'proj/a.txt',
      'proj/sub/',
      'proj/sub/b.txt',
      'solo.txt'
    ])
  })

  it('keeps source files that failed to copy, and the folders holding them', async () => {
    const { src, dst, copy } = await setup()
    await makeTree(src, { 'proj/ok.txt': 'OK', 'proj/blocked/no.txt': 'NO' })
    // Pre-create a read-only destination folder so files inside it can't be written.
    await makeTree(dst, { 'proj/blocked/': null })
    await chmod(join(dst, 'proj/blocked'), 0o555)
    try {
      const job = await copy(['proj'], 'move')
      expect(job.status).toBe('error')
      expect(job.errorCount).toBe(1)
      expect(await listTree(src)).toEqual(['proj/', 'proj/blocked/', 'proj/blocked/no.txt'])
      expect(await read(join(dst, 'proj/ok.txt'))).toBe('OK')
    } finally {
      await chmod(join(dst, 'proj/blocked'), 0o755)
    }
  })

  it('does not delete the source when verification fails', async () => {
    const { src, dst, copy } = await setup({
      wrap: (local, remote) => {
        const bad = Object.create(remote) as FakeRemote
        bad.openWrite = async (path, opts) => {
          const out = await remote.openWrite(path, opts)
          // Silently drop the last byte, like a flaky link might.
          const write = out.write.bind(out)
          out.write = ((chunk: Buffer, ...rest: unknown[]) =>
            (write as (...a: unknown[]) => boolean)(
              chunk.subarray(0, chunk.length - 1),
              ...rest
            )) as typeof out.write
          return out
        }
        return { local, 'ssh:fake': bad }
      }
    })
    await makeTree(src, { 'important.txt': 'do not lose me' })
    const job = await copy(['important.txt'], 'move')
    expect(job.status).toBe('error')
    expect(job.errors[0]!.message).toMatch(/Size mismatch/)
    expect(await read(join(src, 'important.txt'))).toBe('do not lose me')
    expect(await readdir(dst)).toEqual([]) // no half-written file, no .part
  })

  it('falls back to copy and delete when a same-machine rename fails', async () => {
    h = await harness({
      wrap: (local) => {
        const flaky = Object.create(local) as LocalProvider
        flaky.rename = async (from, to, opts) => {
          if (from.endsWith('proj'))
            throw new FsError({
              code: 'EUNKNOWN',
              message: 'EXDEV: cross-device link not permitted'
            })
          return local.rename(from, to, opts)
        }
        return { local: flaky, 'ssh:fake': new FakeRemote() }
      }
    })
    await makeTree(h.root, { 'a/proj/x.txt': 'XX', 'b/': null })
    const job = await h.run(
      req(
        h,
        { machine: 'local', paths: [join(h.root, 'a/proj')] },
        { machine: 'local', dir: join(h.root, 'b') },
        'move'
      )
    )
    expect(job.status).toBe('done')
    expect(await listTree(h.root)).toEqual(['a/', 'b/', 'b/proj/', 'b/proj/x.txt'])
  })
})

describe('cancelling and failing', () => {
  it('cancels mid-file: stops copying, removes the partial file, never creates the final name', async () => {
    const { src, dst } = await setup({
      wrap: (local, remote) => ({ local: slowReads(local, 15), 'ssh:fake': remote })
    })
    await (
      await import('node:fs/promises')
    ).writeFile(join(src, 'big.bin'), randomBytes(6 * 1024 * 1024))
    const id = await h.mgr.start(
      req(h, { machine: 'local', paths: [join(src, 'big.bin')] }, { machine: 'ssh:fake', dir: dst })
    )
    await h.waitFor(id, (j) => j.bytesDone > 256 * 1024)
    expect((await readdir(dst)).some((n) => n.endsWith('.sshbridger-part'))).toBe(true) // in progress

    h.mgr.cancel(id)
    const job = await h.waitFor(id, (j) => j.status === 'cancelled')
    expect(job.bytesDone).toBeLessThan(6 * 1024 * 1024)
    await new Promise((r) => setTimeout(r, 100))
    expect(await readdir(dst)).toEqual([])
  })

  it('cancelling a move leaves the source intact', async () => {
    const { src, dst } = await setup({
      wrap: (local, remote) => ({ local: slowReads(local, 15), 'ssh:fake': remote })
    })
    await (
      await import('node:fs/promises')
    ).writeFile(join(src, 'big.bin'), randomBytes(4 * 1024 * 1024))
    const id = await h.mgr.start(
      req(
        h,
        { machine: 'local', paths: [join(src, 'big.bin')] },
        { machine: 'ssh:fake', dir: dst },
        'move'
      )
    )
    await h.waitFor(id, (j) => j.bytesDone > 128 * 1024)
    h.mgr.cancel(id)
    await h.waitFor(id, (j) => j.status === 'cancelled')
    expect((await stat(join(src, 'big.bin'))).size).toBe(4 * 1024 * 1024)
  })

  it('cancelling a queued job means it never runs', async () => {
    const { src, dst } = await setup({
      maxRunningJobs: 1,
      wrap: (local, remote) => ({ local: slowReads(local, 20), 'ssh:fake': remote })
    })
    await (
      await import('node:fs/promises')
    ).writeFile(join(src, 'big.bin'), randomBytes(3 * 1024 * 1024))
    await makeTree(src, { 'small.txt': 'x' })
    const first = await h.mgr.start(
      req(h, { machine: 'local', paths: [join(src, 'big.bin')] }, { machine: 'ssh:fake', dir: dst })
    )
    const second = await h.mgr.start(
      req(
        h,
        { machine: 'local', paths: [join(src, 'small.txt')] },
        { machine: 'ssh:fake', dir: dst }
      )
    )
    expect(h.mgr.list().find((j) => j.id === second)!.status).toBe('queued')
    h.mgr.cancel(second)
    expect(h.mgr.list().find((j) => j.id === second)!.status).toBe('cancelled')
    h.mgr.cancel(first)
    await h.waitFor(first, (j) => j.status === 'cancelled')
    expect(await readdir(dst)).toEqual([])
  })

  it('reports per-file failures with their paths, finishes the rest, and counts honestly', async () => {
    const { src, dst, copy } = await setup()
    await makeTree(src, { 'ok1.txt': '1', 'bad/inner.txt': 'xx', 'ok2.txt': '2' })
    await makeTree(dst, { 'bad/': null })
    await chmod(join(dst, 'bad'), 0o555)
    try {
      const job = await copy(['ok1.txt', 'bad', 'ok2.txt'])
      expect(job).toMatchObject({ status: 'error', errorCount: 1, filesDone: 2, filesTotal: 2 })
      expect(job.errors[0]!.path).toBe(join(src, 'bad/inner.txt'))
      expect(job.errors[0]!.message).toMatch(/Permission denied/)
      expect(job.errors[0]!.message).toContain(join(dst, 'bad/inner.txt')) // the real name...
      expect(job.errors[0]!.message).not.toContain('.sshbridger-part') // ...never the temp one
      expect(job.bytesDone).toBe(job.bytesTotal)
    } finally {
      await chmod(join(dst, 'bad'), 0o755)
    }
  })

  it('caps the stored error list but still counts every failure', async () => {
    const { src, dst, copy } = await setup()
    const files: Record<string, string> = {}
    for (let i = 0; i < 70; i++) files[`blocked/f${i}.txt`] = 'x'
    await makeTree(src, files)
    await makeTree(dst, { 'blocked/': null })
    await chmod(join(dst, 'blocked'), 0o555)
    try {
      const job = await copy(['blocked'])
      expect(job.errorCount).toBe(70)
      expect(job.errors).toHaveLength(50)
    } finally {
      await chmod(join(dst, 'blocked'), 0o755)
    }
  })

  it('retry re-runs the job and skips what is already up to date', async () => {
    const { src, dst, copy } = await setup()
    await makeTree(src, { 'done.txt': 'already copied', 'locked/inner.txt': 'later' })
    await makeTree(dst, { 'locked/': null })
    await chmod(join(dst, 'locked'), 0o555)
    const first = await copy(['done.txt', 'locked'])
    expect(first.status).toBe('error')
    await chmod(join(dst, 'locked'), 0o755) // the problem is fixed

    const retryId = await h.mgr.retry(first.id)
    expect(h.mgr.list().some((j) => j.id === first.id)).toBe(false)
    const second = await h.waitFor(retryId, (j) => ['done', 'error'].includes(j.status))
    expect(second.status).toBe('done')
    expect(h.conflicts).toHaveLength(0) // nothing to ask: done.txt is identical
    expect(second.skipped).toBe(1)
    expect(await read(join(dst, 'locked/inner.txt'))).toBe('later')
  })

  it('refuses to retry a job it no longer knows', async () => {
    h = await harness()
    await expect(h.mgr.retry('nope')).rejects.toThrow()
  })
})

describe('scheduling and progress', () => {
  it('copies at most N files at once per job', async () => {
    const stats = { open: 0, max: 0 }
    const { src, copy } = await setup({
      perJobConcurrency: 3,
      wrap: (local, remote) => ({ local, 'ssh:fake': trackWrites(remote, stats) })
    })
    const files: Record<string, string> = {}
    for (let i = 0; i < 12; i++) files[`f${i}.txt`] = 'data'
    await makeTree(src, files)
    const job = await copy(Object.keys(files))
    expect(job.status).toBe('done')
    expect(stats.max).toBeGreaterThan(1)
    expect(stats.max).toBeLessThanOrEqual(3)
  })

  it('shares a global limit across jobs', async () => {
    const stats = { open: 0, max: 0 }
    const { src, dst } = await setup({
      perJobConcurrency: 4,
      globalConcurrency: 2,
      maxRunningJobs: 3,
      wrap: (local, remote) => ({ local, 'ssh:fake': trackWrites(remote, stats) })
    })
    const files: Record<string, string> = {}
    for (let i = 0; i < 9; i++) files[`f${i}.txt`] = 'data'
    await makeTree(src, files)
    const ids = await Promise.all(
      [0, 3, 6].map((from) =>
        h.mgr.start(
          req(
            h,
            {
              machine: 'local',
              paths: Object.keys(files)
                .slice(from, from + 3)
                .map((n) => join(src, n))
            },
            { machine: 'ssh:fake', dir: dst }
          )
        )
      )
    )
    for (const id of ids) await h.waitFor(id, (j) => j.status === 'done')
    expect(stats.max).toBeLessThanOrEqual(2)
  })

  it('queues jobs beyond the running limit and runs them in order', async () => {
    const { src, dst } = await setup({ maxRunningJobs: 1 })
    await makeTree(src, { 'a.txt': 'a', 'b.txt': 'b' })
    const a = await h.mgr.start(
      req(h, { machine: 'local', paths: [join(src, 'a.txt')] }, { machine: 'ssh:fake', dir: dst })
    )
    const b = await h.mgr.start(
      req(h, { machine: 'local', paths: [join(src, 'b.txt')] }, { machine: 'ssh:fake', dir: dst })
    )
    expect(h.mgr.list().find((j) => j.id === b)!.status).toBe('queued')
    await h.waitFor(b, (j) => j.status === 'done')
    expect(h.mgr.list().find((j) => j.id === a)!.status).toBe('done')
  })

  it('starts queued jobs when the running limit is raised', async () => {
    const { src, dst } = await setup({
      maxRunningJobs: 1,
      wrap: (local, remote) => ({ local: slowReads(local, 20), 'ssh:fake': remote })
    })
    await (
      await import('node:fs/promises')
    ).writeFile(join(src, 'big.bin'), randomBytes(2 * 1024 * 1024))
    await makeTree(src, { 'b.txt': 'b' })
    const a = await h.mgr.start(
      req(h, { machine: 'local', paths: [join(src, 'big.bin')] }, { machine: 'ssh:fake', dir: dst })
    )
    const b = await h.mgr.start(
      req(h, { machine: 'local', paths: [join(src, 'b.txt')] }, { machine: 'ssh:fake', dir: dst })
    )
    expect(h.mgr.list().find((j) => j.id === b)!.status).toBe('queued')
    h.limits.maxRunningJobs = 2
    h.mgr.limitsChanged()
    await h.waitFor(b, (j) => j.status !== 'queued')
    expect(h.mgr.list().find((j) => j.id === a)!.status).not.toBe('done') // b did not wait for a
    h.mgr.cancel(a)
  })

  it('applies a changed global file limit to transfers already running', async () => {
    const stats = { open: 0, max: 0 }
    const { src, dst } = await setup({
      perJobConcurrency: 8,
      globalConcurrency: 1,
      wrap: (local, remote) => ({ local, 'ssh:fake': trackWrites(remote, stats) })
    })
    const files: Record<string, string> = {}
    for (let i = 0; i < 10; i++) files[`f${i}.txt`] = 'data'
    await makeTree(src, files)
    h.limits.globalConcurrency = 4
    h.mgr.limitsChanged()
    const job = await h.run(
      req(
        h,
        { machine: 'local', paths: Object.keys(files).map((f) => join(src, f)) },
        { machine: 'ssh:fake', dir: dst }
      )
    )
    expect(job.status).toBe('done')
    expect(stats.max).toBeGreaterThan(1)
    expect(stats.max).toBeLessThanOrEqual(4)
  })

  it('reports speed, estimated time and the names being copied while running', async () => {
    const { src, dst } = await setup({
      wrap: (local, remote) => ({ local: slowReads(local, 10), 'ssh:fake': remote })
    })
    await (
      await import('node:fs/promises')
    ).writeFile(join(src, 'movie.bin'), randomBytes(5 * 1024 * 1024))
    const id = await h.mgr.start(
      req(
        h,
        { machine: 'local', paths: [join(src, 'movie.bin')] },
        { machine: 'ssh:fake', dir: dst }
      )
    )
    const running = await h.waitFor(
      id,
      (j) => j.status === 'running' && j.speed > 0 && j.etaSeconds !== null
    )
    expect(running.current).toEqual(['movie.bin'])
    expect(running.bytesTotal).toBe(5 * 1024 * 1024)
    expect(running.speed).toBeGreaterThan(0)
    h.mgr.cancel(id)
    await h.waitFor(id, (j) => j.status === 'cancelled')
  })

  it('batches progress updates instead of flooding the renderer, and always sends the final state', async () => {
    const { src, copy } = await setup({ flushMs: 50 })
    await (
      await import('node:fs/promises')
    ).writeFile(join(src, 'f.bin'), randomBytes(8 * 1024 * 1024))
    const job = await copy(['f.bin'])
    const progress = h.updates.flat().filter((j) => j.id === job.id)
    expect(h.updates.length).toBeLessThan(40) // not one per chunk (32 chunks of 256 KB, plus status changes)
    expect(progress.at(-1)).toMatchObject({ status: 'done', bytesDone: 8 * 1024 * 1024 })
    const bytes = progress.map((p) => p.bytesDone)
    expect([...bytes].sort((a, b) => a - b)).toEqual(bytes) // never goes backwards
  })

  it('clears only finished jobs', async () => {
    const { src, dst, copy } = await setup({
      wrap: (local, remote) => ({ local: slowReads(local, 20), 'ssh:fake': remote })
    })
    await makeTree(src, { 'small.txt': 'x' })
    await (
      await import('node:fs/promises')
    ).writeFile(join(src, 'big.bin'), randomBytes(4 * 1024 * 1024))
    const finished = await copy(['small.txt'])
    const running = await h.mgr.start(
      req(h, { machine: 'local', paths: [join(src, 'big.bin')] }, { machine: 'ssh:fake', dir: dst })
    )
    h.mgr.clear()
    expect(h.mgr.list().map((j) => j.id)).toEqual([running])
    expect(h.mgr.list().some((j) => j.id === finished.id)).toBe(false)
    h.mgr.cancel(running)
    await h.waitFor(running, (j) => j.status === 'cancelled')
    h.mgr.clear(running)
    expect(h.mgr.list()).toEqual([])
  })
})

void LocalProvider
void mkdir
