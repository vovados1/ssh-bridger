/** Permission bits as the Permissions dialog edits them. */
export const MODE_BITS = {
  ownerRead: 0o400,
  ownerWrite: 0o200,
  ownerExec: 0o100,
  groupRead: 0o040,
  groupWrite: 0o020,
  groupExec: 0o010,
  otherRead: 0o004,
  otherWrite: 0o002,
  otherExec: 0o001,
  setuid: 0o4000,
  setgid: 0o2000,
  sticky: 0o1000
} as const

export type ModeBit = keyof typeof MODE_BITS

export function hasBit(mode: number, bit: ModeBit): boolean {
  return (mode & MODE_BITS[bit]) !== 0
}

export function toggleBit(mode: number, bit: ModeBit): number {
  return mode ^ MODE_BITS[bit]
}

/** `0o644` -> `644`; special bits add a fourth digit (`2755`). */
export function modeToOctal(mode: number): string {
  const text = (mode & 0o7777).toString(8)
  return mode & 0o7000 ? text.padStart(4, '0') : text.padStart(3, '0')
}

/** Parse 1-4 octal digits; null when the text isn't a valid mode. */
export function parseOctal(text: string): number | null {
  return /^[0-7]{1,4}$/.test(text.trim()) ? parseInt(text.trim(), 8) : null
}
