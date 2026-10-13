/**
 * Tiny POSIX path helpers usable in every process (no `node:path` in the renderer).
 * All paths are absolute and use `/`, on every machine.
 */

/** Collapse `.`, `..` and repeated slashes. The result always starts with `/`. */
export function normalizePath(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? '/' + name : dir + '/' + name
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

export function baseName(path: string): string {
  if (path === '/') return '/'
  return path.slice(path.lastIndexOf('/') + 1)
}

export interface Crumb {
  name: string
  path: string
}

/** `/a/b` -> [`/`, `/a`, `/a/b`]; used by the path bar. */
export function breadcrumbs(path: string): Crumb[] {
  const crumbs: Crumb[] = [{ name: '/', path: '/' }]
  let acc = ''
  for (const part of path.split('/').filter(Boolean)) {
    acc += '/' + part
    crumbs.push({ name: part, path: acc })
  }
  return crumbs
}

/** Expand a leading `~` against `home`, then normalize. Relative input resolves against `cwd`. */
export function resolveInput(input: string, cwd: string, home: string): string {
  const trimmed = input.trim()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/')) return normalizePath(home + '/' + trimmed.slice(2))
  if (trimmed.startsWith('/')) return normalizePath(trimmed)
  return normalizePath(cwd + '/' + trimmed)
}
