import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Read a JSON file; null if it does not exist. Throws on unreadable or malformed content. */
export async function readJson(path: string): Promise<unknown | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return JSON.parse(text)
}

/** Write atomically (temp file + rename) with private permissions, so a crash can't leave half a file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, path)
}

/** Move an unreadable file aside instead of overwriting it, so the user can recover it. */
export async function quarantine(path: string): Promise<string> {
  const target = `${path}.corrupt-${Date.now()}`
  await rename(path, target)
  return target
}
