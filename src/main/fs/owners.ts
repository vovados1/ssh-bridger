import { readFile } from 'node:fs/promises'

/** Parse `/etc/passwd` or `/etc/group` into id -> name. Malformed lines are skipped. */
export function parseIdMap(text: string): Map<number, string> {
  const map = new Map<number, string>()
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const [name, , id] = line.split(':')
    const n = Number(id)
    if (name && id !== undefined && Number.isInteger(n) && !map.has(n)) map.set(n, name)
  }
  return map
}

async function readMap(file: string): Promise<Map<number, string>> {
  try {
    return parseIdMap(await readFile(file, 'utf8'))
  } catch {
    return new Map()
  }
}

/** Resolve numeric ids to user/group names via the local passwd and group files. */
export async function lookupOwner(
  uid: number,
  gid: number
): Promise<{ owner?: string; group?: string }> {
  const [users, groups] = await Promise.all([readMap('/etc/passwd'), readMap('/etc/group')])
  const owner = users.get(uid)
  const group = groups.get(gid)
  return { ...(owner === undefined ? {} : { owner }), ...(group === undefined ? {} : { group }) }
}
