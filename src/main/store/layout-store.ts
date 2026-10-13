import type { Layout } from '@shared/layout'
import { LayoutSchema } from '@shared/transfer-schemas'
import { quarantine, readJson, writeJsonAtomic } from './json-file'

/** The saved column layout. Losing it is harmless, so problems fall back to "no layout". */
export class LayoutStore {
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  /** Null when nothing is saved or the file can't be used (it is moved aside, not deleted). */
  async load(): Promise<Layout | null> {
    try {
      const raw = await readJson(this.file)
      return raw === null ? null : LayoutSchema.parse(raw)
    } catch {
      await quarantine(this.file).catch(() => {})
      return null
    }
  }

  save(layout: Layout): Promise<void> {
    const valid = LayoutSchema.parse(layout)
    this.writing = this.writing.then(() => writeJsonAtomic(this.file, valid))
    return this.writing
  }
}
