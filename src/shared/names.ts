/** Longest file name Linux filesystems accept, in bytes. */
export const MAX_NAME_BYTES = 255

/**
 * Why `name` can't be used as a single file or folder name, or null if it is fine.
 * Used by the UI before it ever asks a machine to rename or create something.
 */
export function nameProblem(name: string): string | null {
  if (name.trim() === '') return 'Name cannot be empty'
  if (name === '.' || name === '..') return `"${name}" is not a valid name`
  if (name.includes('/')) return 'Name cannot contain "/"'
  if (name.includes('\0')) return 'Name cannot contain null characters'
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return 'Name is too long'
  return null
}

/** `New Folder`, `New Folder 2`, ... : the first candidate not in `taken`. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Length of the part of `name` before its extension; used to pre-select it for renaming. */
export function stemLength(name: string): number {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name.length : dot
}
