import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { harness, listTree, type Harness } from '../helpers/transfer-harness'
import { connectSftp, type SftpConnection } from '../helpers/sftp-fixture'
import { sshdAvailable, startSshd, type TestSshd } from '../helpers/sshd'

/**
 * Size of the big-file test in MB. The default keeps the suite quick; for a real stress run,
 * e.g. past the 2 GiB mark where offsets stop fitting in 32 bits:
 *   BRIDGER_STRESS_MB=2600 pnpm exec vitest run test/integration/transfer-stress.test.ts
 */
const BIG_MB = Number(process.env['BRIDGER_STRESS_MB'] ?? 64)
const FILES = Number(process.env['BRIDGER_STRESS_FILES'] ?? 1500)

let server: TestSshd
beforeAll(async () => {
  if (sshdAvailable) server = await startSshd()
})
afterAll(async () => {
  await server?.stop()
})

let h: Harness
const LONG = 30 * 60_000
const run = (request: Parameters<Harness['run']>[0]) => h.run(request, LONG)
let conn: SftpConnection
let scratch: string
afterEach(async () => {
  await h?.cleanup()
  await conn?.teardown()
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

async function setup() {
  scratch = await mkdtemp(join(tmpdir(), 'bridger-stress-'))
  conn = await connectSftp(server, scratch)
  h = await harness({
    wrap: (local) => ({ local, [conn.machineId]: conn.provider }),
    flushMs: 100
  })
  const src = join(h.root, 'src')
  const mid = join(h.root, 'mid')
  const back = join(h.root, 'back')
  for (const d of [src, mid, back]) await mkdir(d)
  return { src, mid, back, remote: conn.machineId }
}

/** Deterministic, incompressible-looking data that is cheap to generate without holding it in memory. */
function patternStream(bytes: number): Readable {
  let written = 0
  let counter = 0
  return new Readable({
    read() {
      if (written >= bytes) return void this.push(null)
      const size = Math.min(1 << 20, bytes - written)
      const buf = new ArrayBuffer(Math.ceil(size / 4) * 4) // whole words; the last may be cut short
      const words = new Uint32Array(buf)
      for (let i = 0; i < words.length; i++) {
        // Mixes the absolute position in, so a block written at the wrong offset shows up in the hash.
        counter = (counter + 0x9e3779b9) >>> 0
        let x = counter ^ (written + i * 4)
        x = Math.imul(x ^ (x >>> 15), 0x85ebca6b)
        x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
        words[i] = x >>> 0
      }
      const chunk = Buffer.from(buf, 0, size)
      written += chunk.length
      this.push(chunk)
    }
  })
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

describe.skipIf(!sshdAvailable)('stress', () => {
  it('does not stall small requests (Nagle plus delayed ACK would add ~40 ms to each)', async () => {
    const { src } = await setup()
    const t0 = Date.now()
    for (let i = 0; i < 60; i++) await conn.provider.stat(src)
    const ms = Date.now() - t0
    expect(ms).toBeLessThan(1000) // ~10 ms in practice; 60 stalled round trips would take 2.4 s
  })

  it('does not buffer a file in memory when the destination is slower than the network', async () => {
    const { src } = await setup()
    const file = join(src, 'slow.bin')
    await pipeline(patternStream(24 * 1024 * 1024), createWriteStream(file))
    const stream = await conn.provider.openRead(file)
    let received = 0
    let maxBuffered = 0
    for await (const chunk of stream) {
      received += (chunk as Buffer).length
      maxBuffered = Math.max(maxBuffered, stream.readableLength)
      if (received % (1 << 20) < 32768) await new Promise((r) => setTimeout(r, 2)) // a slow disk
    }
    expect(received).toBe(24 * 1024 * 1024)
    // Without backpressure this reaches most of the file (24 MB); with it, a few chunks.
    expect(maxBuffered).toBeLessThan(1024 * 1024)
  })

  it(`moves ${FILES} small files in nested folders up and back down intact`, async () => {
    const { src, mid, back, remote } = await setup()
    const perDir = 50
    let totalBytes = 0
    for (let i = 0; i < FILES; i++) {
      const dir = join(src, 'tree', `d${Math.floor(i / perDir)}`, i % 2 ? 'odd' : 'even')
      await mkdir(dir, { recursive: true })
      const body = `file ${i} ${'x'.repeat(i % 97)}`
      totalBytes += Buffer.byteLength(body)
      await writeFile(join(dir, `f${i}.txt`), body)
    }

    const t0 = Date.now()
    const up = await run({
      source: { machineId: 'local', paths: [join(src, 'tree')] },
      dest: { machineId: remote, dir: mid },
      mode: 'copy'
    })
    const upMs = Date.now() - t0
    expect(up).toMatchObject({
      status: 'done',
      errorCount: 0,
      filesDone: FILES,
      bytesDone: totalBytes
    })

    const t1 = Date.now()
    const down = await run({
      source: { machineId: remote, paths: [join(mid, 'tree')] },
      dest: { machineId: 'local', dir: back },
      mode: 'copy'
    })
    const downMs = Date.now() - t1
    expect(down).toMatchObject({ status: 'done', errorCount: 0, filesDone: FILES })

    expect(await listTree(join(back, 'tree'))).toEqual(await listTree(join(src, 'tree')))
    expect(await sha256Tree(join(back, 'tree'))).toBe(await sha256Tree(join(src, 'tree')))
    console.log(
      `  ${FILES} files: up ${upMs} ms (${Math.round((FILES / upMs) * 1000)}/s), down ${downMs} ms (${Math.round((FILES / downMs) * 1000)}/s)`
    )
  }, 180_000)

  it(
    `copies a ${BIG_MB} MB file up and back down bit-for-bit, with bounded memory`,
    async () => {
      const { src, mid, back, remote } = await setup()
      const bytes = BIG_MB * 1024 * 1024 + 12_345 // not a multiple of any chunk size
      await pipeline(patternStream(bytes), createWriteStream(join(src, 'big.bin')))
      expect((await stat(join(src, 'big.bin'))).size).toBe(bytes)
      const want = await sha256(join(src, 'big.bin'))

      let peak = 0
      const gc = (globalThis as { gc?: () => void }).gc
      const sampler = setInterval(() => {
        if (process.env['BRIDGER_STRESS_GC']) gc?.()
        peak = Math.max(peak, process.memoryUsage().rss)
      }, 50)
      const rssBefore = process.memoryUsage().rss
      try {
        const t0 = Date.now()
        const up = await run({
          source: { machineId: 'local', paths: [join(src, 'big.bin')] },
          dest: { machineId: remote, dir: mid },
          mode: 'copy'
        })
        const upMs = Date.now() - t0
        expect(up).toMatchObject({ status: 'done', errorCount: 0, bytesDone: bytes })
        expect(await sha256(join(mid, 'big.bin'))).toBe(want)

        const t1 = Date.now()
        const down = await run({
          source: { machineId: remote, paths: [join(mid, 'big.bin')] },
          dest: { machineId: 'local', dir: back },
          mode: 'copy'
        })
        const downMs = Date.now() - t1
        expect(down).toMatchObject({ status: 'done', errorCount: 0, bytesDone: bytes })
        expect(await sha256(join(back, 'big.bin'))).toBe(want)

        const mb = bytes / 1024 / 1024
        console.log(
          `  ${Math.round(mb)} MB: up ${Math.round(mb / (upMs / 1000))} MB/s, down ${Math.round(mb / (downMs / 1000))} MB/s, peak RSS +${Math.round((peak - rssBefore) / 1024 / 1024)} MB`
        )
      } finally {
        clearInterval(sampler)
      }
      // Streaming: memory must not grow with the file. (Generous: the test process also hashes and runs sshd I/O.)
      expect(peak - rssBefore).toBeLessThan(400 * 1024 * 1024)
    },
    30 * 60_000
  )
})

async function sha256Tree(root: string): Promise<string> {
  const hash = createHash('sha256')
  for (const rel of (await listTree(root)).filter((p) => !p.endsWith('/'))) {
    hash.update(rel)
    hash.update(await sha256(join(root, rel)))
  }
  return hash.digest('hex')
}
