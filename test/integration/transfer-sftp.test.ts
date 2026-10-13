import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readdir, readlink, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { MachineId } from '@shared/fs-types'
import type { TransferMode, TransferRequest } from '@shared/transfers'
import { harness, listTree, makeTree, read, type Harness } from '../helpers/transfer-harness'
import { connectSftp, type SftpConnection } from '../helpers/sftp-fixture'
import { sshdAvailable, startSshd, type TestSshd } from '../helpers/sshd'
import { startProxy, type TcpProxy } from '../helpers/tcp-proxy'

let serverA: TestSshd
let serverB: TestSshd
beforeAll(async () => {
  if (!sshdAvailable) return
  ;[serverA, serverB] = await Promise.all([startSshd(), startSshd()])
})
afterAll(async () => {
  await Promise.all([serverA?.stop(), serverB?.stop()])
})

let h: Harness
let conns: SftpConnection[] = []
let proxies: TcpProxy[] = []
afterEach(async () => {
  await h?.cleanup()
  await Promise.all(conns.map((c) => c.teardown()))
  await Promise.all(proxies.map((p) => p.stop()))
  conns = []
  proxies = []
})

/**
 * Local plus two SFTP machines, all rooted in the same temp tree (the servers run as this
 * user), so every path in a transfer can be checked directly on disk.
 */
async function setup(opts: { latencyMs?: number; perJobConcurrency?: number } = {}) {
  let portA = serverA.port
  if (opts.latencyMs) {
    const proxy = await startProxy(serverA.port, opts.latencyMs)
    proxies.push(proxy)
    portA = proxy.port
  }
  const scratchHolder = await (
    await import('node:fs/promises')
  ).mkdtemp(join((await import('node:os')).tmpdir(), 'bridger-x-'))
  const a = await connectSftp(serverA, scratchHolder, portA)
  const b = await connectSftp(serverB, scratchHolder)
  conns.push(a, b)
  h = await harness({
    ...(opts.perJobConcurrency ? { perJobConcurrency: opts.perJobConcurrency } : {}),
    wrap: (local) => ({ local, [a.machineId]: a.provider, [b.machineId]: b.provider })
  })
  const dirs = { src: join(h.root, 'src'), dst: join(h.root, 'dst') }
  await mkdir(dirs.src)
  await mkdir(dirs.dst)
  const run = (
    from: MachineId,
    names: string[],
    to: MachineId,
    mode: TransferMode = 'copy',
    srcDir = dirs.src,
    dstDir = dirs.dst
  ) =>
    h.run({
      source: { machineId: from, paths: names.map((n) => join(srcDir, n)) },
      dest: { machineId: to, dir: dstDir },
      mode
    } satisfies TransferRequest)
  return { ...dirs, a: a.machineId, b: b.machineId, run, aConn: a, proxies }
}

describe.skipIf(!sshdAvailable)('transfers over real SFTP', () => {
  it('uploads a folder tree (local -> remote) with contents, symlinks, permissions and times', async () => {
    const { src, dst, a, run } = await setup()
    await makeTree(src, {
      'proj/readme.md': '# hi',
      'proj/src/a.ts': 'code',
      'proj/empty/': null,
      'proj/.env': 'S=1'
    })
    await symlink('readme.md', join(src, 'proj/link'))
    await chmod(join(src, 'proj/readme.md'), 0o640)
    const when = new Date('2022-02-03T04:05:06Z')
    await utimes(join(src, 'proj/readme.md'), when, when)

    const job = await run('local', ['proj'], a)
    expect(job).toMatchObject({ status: 'done', errorCount: 0 })
    expect(await listTree(join(dst, 'proj'))).toEqual(await listTree(join(src, 'proj')))
    expect(await readlink(join(dst, 'proj/link'))).toBe('readme.md')
    expect((await stat(join(dst, 'proj/readme.md'))).mode & 0o7777).toBe(0o640)
    expect(
      Math.abs((await stat(join(dst, 'proj/readme.md'))).mtimeMs - when.getTime())
    ).toBeLessThan(1500)
    expect(job.filesDone).toBe(job.filesTotal)
  })

  it('downloads (remote -> local)', async () => {
    const { src, dst, a, run } = await setup()
    await makeTree(src, { 'data/x.txt': 'XX', 'data/sub/y.txt': 'YYY' })
    const job = await run(a, ['data'], 'local')
    expect(job).toMatchObject({ status: 'done', bytesDone: 5 })
    expect(await listTree(join(dst, 'data'))).toEqual(['sub/', 'sub/y.txt', 'x.txt'])
  })

  it('copies between two different servers through the app (remote -> remote)', async () => {
    const { src, dst, a, b, run } = await setup()
    const big = randomBytes(3 * 1024 * 1024 + 99)
    await makeTree(src, { 'tree/small.txt': 'hello', 'tree/nested/deep.txt': 'deep' })
    await writeFile(join(src, 'tree/big.bin'), big)
    const job = await run(a, ['tree'], b)
    expect(job).toMatchObject({ status: 'done', errorCount: 0 })
    expect(
      Buffer.compare(
        await (await import('node:fs/promises')).readFile(join(dst, 'tree/big.bin')),
        big
      )
    ).toBe(0)
    expect(await read(join(dst, 'tree/nested/deep.txt'))).toBe('deep')
  })

  it('copies within one remote machine, and never overwrites an item copied onto itself', async () => {
    const { src, a, run } = await setup()
    await makeTree(src, { 'f.txt': 'F', 'other/': null })
    await run(a, ['f.txt'], a, 'copy', src, join(src, 'other'))
    expect(await read(join(src, 'other/f.txt'))).toBe('F')
    const again = await run(a, ['f.txt'], a, 'copy', src, src) // onto itself
    expect(again.status).toBe('done')
    expect(await listTree(src)).toEqual(['f (copy).txt', 'f.txt', 'other/', 'other/f.txt'])
  })

  it('moves within one remote machine by renaming, including a whole folder', async () => {
    const { src, dst, a, run } = await setup()
    await makeTree(src, { 'proj/a.txt': 'A', 'proj/sub/b.txt': 'B' })
    const job = await run(a, ['proj'], a, 'move')
    expect(job).toMatchObject({ status: 'done', filesDone: 2, filesTotal: 2 })
    expect(await listTree(src)).toEqual([])
    expect(await listTree(dst)).toEqual(['proj/', 'proj/a.txt', 'proj/sub/', 'proj/sub/b.txt'])
  })

  it('moves across machines: remote source files are deleted over SFTP once copied', async () => {
    const { src, dst, a, run } = await setup()
    await makeTree(src, { 'proj/a.txt': 'A', 'proj/sub/b.txt': 'BB', 'solo.txt': 'S' })
    const job = await run(a, ['proj', 'solo.txt'], 'local', 'move')
    expect(job).toMatchObject({ status: 'done', filesDone: 3 })
    expect(await listTree(src)).toEqual([])
    expect(await listTree(dst)).toEqual([
      'proj/',
      'proj/a.txt',
      'proj/sub/',
      'proj/sub/b.txt',
      'solo.txt'
    ])
  })

  it('resolves conflicts on a remote destination: overwrite uses an atomic rename, keep-both and skip work', async () => {
    const { src, dst, a, run } = await setup()
    await makeTree(src, { 'over.txt': 'NEW-OVER', 'both.txt': 'NEW-BOTH', 'skip.txt': 'NEW-SKIP' })
    await makeTree(dst, { 'over.txt': 'old', 'both.txt': 'old-both', 'skip.txt': 'old-skip' })
    h.autoAnswer([
      { resolution: 'keepBoth', applyToAll: false },
      { resolution: 'overwrite', applyToAll: false },
      { resolution: 'skip', applyToAll: false }
    ])
    const job = await run('local', ['both.txt', 'over.txt', 'skip.txt'], a)
    expect(job).toMatchObject({ status: 'done', skipped: 1 })
    expect(await read(join(dst, 'over.txt'))).toBe('NEW-OVER')
    expect(await read(join(dst, 'both.txt'))).toBe('old-both')
    expect(await read(join(dst, 'both (copy).txt'))).toBe('NEW-BOTH')
    expect(await read(join(dst, 'skip.txt'))).toBe('old-skip')
    expect((await readdir(dst)).some((n) => n.endsWith('.sshbridger-part'))).toBe(false)
  })

  it('reports permission errors from the server with a readable message and keeps going', async () => {
    const { src, dst, a, run } = await setup()
    await makeTree(src, { 'ok.txt': 'ok', 'locked/in.txt': 'x' })
    await makeTree(dst, { 'locked/': null })
    await chmod(join(dst, 'locked'), 0o555)
    try {
      const job = await run('local', ['ok.txt', 'locked'], a)
      expect(job).toMatchObject({ status: 'error', errorCount: 1, filesDone: 1 })
      expect(job.errors[0]!.message).toMatch(/Permission denied/)
    } finally {
      await chmod(join(dst, 'locked'), 0o755)
    }
  })

  it('cancels a slow upload cleanly: no partial file, and the connection keeps working', async () => {
    const { src, dst, a, run, aConn } = await setup({ latencyMs: 25 })
    await writeFile(join(src, 'big.bin'), randomBytes(12 * 1024 * 1024))
    const id = await h.mgr.start({
      source: { machineId: 'local', paths: [join(src, 'big.bin')] },
      dest: { machineId: a, dir: dst },
      mode: 'copy'
    })
    await h.waitFor(id, (j) => j.bytesDone > 512 * 1024, 15_000)
    h.mgr.cancel(id)
    const job = await h.waitFor(id, (j) => j.status === 'cancelled', 15_000)
    expect(job.bytesDone).toBeLessThan(12 * 1024 * 1024)
    await new Promise((r) => setTimeout(r, 300))
    expect(await readdir(dst)).toEqual([])
    // The same connection (browsing channel and a fresh transfer channel) still works.
    expect((await aConn.provider.list(src)).map((e) => e.name)).toEqual(['big.bin'])
    await writeFile(join(src, 'after.txt'), 'x')
    expect((await run('local', ['after.txt'], a)).status).toBe('done')
  }, 60_000)

  it('is fast over a high-latency link thanks to pipelined requests', async () => {
    const { src, dst, a, run } = await setup({ latencyMs: 15 })
    const data = randomBytes(16 * 1024 * 1024)
    await writeFile(join(src, 'big.bin'), data)
    const t0 = Date.now()
    const job = await run('local', ['big.bin'], a)
    const ms = Date.now() - t0
    expect(job.status).toBe('done')
    console.log(
      `INFO  16 MB upload over a 30 ms RTT link: ${ms} ms (${((16 / ms) * 1000).toFixed(1)} MB/s)`
    )
    // One request per round trip would take 16 MB / 32 KB * 30 ms = 15 s.
    expect(ms).toBeLessThan(9000)
    expect(
      Buffer.compare(await (await import('node:fs/promises')).readFile(join(dst, 'big.bin')), data)
    ).toBe(0)
  }, 60_000)

  it('survives a dropped connection: the job fails clearly, and a retry after reconnect finishes it', async () => {
    const { src, dst, a, aConn } = await setup({ latencyMs: 10 })
    await writeFile(join(src, 'big.bin'), randomBytes(10 * 1024 * 1024))
    await makeTree(src, { 'small.txt': 'small' })
    const proxy = proxies[0]!
    const id = await h.mgr.start({
      source: { machineId: 'local', paths: [join(src, 'small.txt'), join(src, 'big.bin')] },
      dest: { machineId: a, dir: dst },
      mode: 'copy'
    })
    await h.waitFor(id, (j) => j.bytesDone > 300 * 1024, 15_000)
    proxy.dropAll()
    const failed = await h.waitFor(id, (j) => ['error', 'done'].includes(j.status), 20_000)
    expect(failed.status).toBe('error')
    expect(failed.errors.length).toBeGreaterThan(0)
    expect(await readdir(dst)).not.toContain('big.bin') // never appears under its real name

    // Wait for the automatic reconnect, then retry.
    const deadline = Date.now() + 15_000
    for (;;) {
      try {
        await aConn.provider.list(dst)
        break
      } catch {
        if (Date.now() > deadline) throw new Error('did not reconnect')
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    const retried = await h.waitFor(
      await h.mgr.retry(id),
      (j) => ['done', 'error'].includes(j.status),
      30_000
    )
    expect(retried.status).toBe('done')
    expect(await listTree(dst)).toEqual(['big.bin', 'small.txt'])
    expect(retried.skipped).toBeGreaterThanOrEqual(0)
  }, 90_000)
})
