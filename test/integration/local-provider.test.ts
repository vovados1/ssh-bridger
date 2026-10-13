import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LocalProvider } from '../../src/main/fs/local-provider'

/** Local-only behaviour. Everything the providers share lives in provider-contract.test.ts. */
const provider = new LocalProvider()
let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bridger-local-'))
})
afterAll(() => rm(root, { recursive: true, force: true }))

describe('LocalProvider specifics', () => {
  it.skipIf(process.getuid?.() === 0)(
    'keeps names in folders that are readable but not traversable',
    async () => {
      const dir = join(root, 'read-only-dir')
      await mkdir(dir)
      await writeFile(join(dir, 'secret.txt'), '')
      await chmod(dir, 0o444)
      try {
        const entries = await provider.list(dir)
        expect(entries.map((e) => e.name)).toEqual(['secret.txt'])
        expect(entries[0]).toMatchObject({ type: 'file', size: 0, mtime: 0 })
      } finally {
        await chmod(dir, 0o700)
      }
    }
  )
})
