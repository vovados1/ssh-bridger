/**
 * Name for a second copy of something that is already there: `report.pdf` becomes
 * `report (copy).pdf`, then `report (copy 2).pdf`, and so on.
 */
export async function uniqueCopyName(
  name: string,
  isDir: boolean,
  isTaken: (candidate: string) => Promise<boolean>
): Promise<string> {
  const { stem, ext } = isDir ? { stem: name, ext: '' } : splitExtension(name)
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n === 1 ? 'copy' : `copy ${n}`})${ext}`
    if (!(await isTaken(candidate))) return candidate
  }
}

/** `archive.tar.gz` -> stem `archive`, ext `.tar.gz`; dotfiles keep their whole name as the stem. */
export function splitExtension(name: string): { stem: string; ext: string } {
  const tar = /^(.+?)(\.tar\.[A-Za-z0-9]+)$/.exec(name)
  if (tar) return { stem: tar[1]!, ext: tar[2]! }
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? { stem: name, ext: '' } : { stem: name.slice(0, dot), ext: name.slice(dot) }
}
