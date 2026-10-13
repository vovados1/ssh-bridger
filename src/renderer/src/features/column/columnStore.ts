import { createStore, type StoreApi } from 'zustand/vanilla'
import { FsError, isDirLike, type Entry, type FsErrorData, type MachineId } from '@shared/fs-types'
import { parentOf, resolveInput } from '@shared/posix-path'
import type { FsClient } from '../../lib/fs-client'
import { computeVisible, type SortDir, type SortKey } from './sort'

export interface ColumnState {
  machineId: MachineId
  home: string | null
  /** Directory currently shown; null until the first listing arrives. */
  cwd: string | null
  history: string[]
  historyIndex: number
  /** Everything in `cwd`, as returned by the provider. */
  entries: Entry[]
  /** `entries` after the hidden filter and sort; this is what the list renders. */
  visible: Entry[]
  loading: boolean
  error: FsErrorData | null
  showHidden: boolean
  sortKey: SortKey
  sortDir: SortDir
  selected: ReadonlySet<string>
  /** The keyboard cursor, by path. */
  cursor: string | null
  /** Where shift-selection ranges start. */
  anchor: string | null

  init(): Promise<void>
  /** Go to a typed or clicked path. `~` and relative paths are resolved. */
  navigate(input: string): Promise<boolean>
  back(): Promise<void>
  forward(): Promise<void>
  up(): Promise<void>
  refresh(): Promise<void>
  open(entry: Entry): Promise<void>
  openCursor(): Promise<void>
  clearError(): void

  toggleHidden(): void
  setSort(key: SortKey): void

  selectOnly(path: string): void
  toggleSelect(path: string): void
  selectRange(path: string): void
  selectAll(): void
  clearSelection(): void
  moveCursor(delta: number, extend: boolean): void
  cursorTo(where: 'first' | 'last', extend: boolean): void
}

export interface ColumnStoreOptions {
  machineId: MachineId
  fs: FsClient
}

export type ColumnStore = StoreApi<ColumnState>

type HistoryMode = 'push' | 'keep'

export function createColumnStore({ machineId, fs }: ColumnStoreOptions): ColumnStore {
  /** Only the latest listing request may apply its result; older ones are stale. */
  let requestSeq = 0

  return createStore<ColumnState>()((set, get) => {
    /**
     * List `path` and, if it is still the latest request, make it the current folder.
     * A failed listing leaves the previous folder on screen and only sets `error`.
     */
    async function load(
      path: string,
      history: HistoryMode,
      opts: { cursor?: string | null; keepSelection?: boolean } = {}
    ): Promise<boolean> {
      const seq = ++requestSeq
      set({ loading: true })
      try {
        const entries = await fs.list(machineId, path)
        if (seq !== requestSeq) return false
        const s = get()
        const visible = computeVisible(entries, s.showHidden, s.sortKey, s.sortDir)
        const paths = new Set(visible.map((e) => e.path))

        let selected: ReadonlySet<string> = new Set()
        let cursor: string | null = null
        let anchor: string | null = null
        if (opts.keepSelection) {
          selected = new Set([...s.selected].filter((p) => paths.has(p)))
          cursor = s.cursor && paths.has(s.cursor) ? s.cursor : null
          anchor = s.anchor && paths.has(s.anchor) ? s.anchor : null
        }
        if (opts.cursor && paths.has(opts.cursor)) {
          cursor = opts.cursor
          anchor = opts.cursor
          selected = new Set([opts.cursor])
        }
        cursor ??= visible[0]?.path ?? null

        let { history: hist, historyIndex } = s
        if (history === 'push' && hist[historyIndex] !== path) {
          hist = [...hist.slice(0, historyIndex + 1), path]
          historyIndex = hist.length - 1
        }
        set({
          cwd: path,
          entries,
          visible,
          selected,
          cursor,
          anchor,
          history: hist,
          historyIndex,
          loading: false,
          error: null
        })
        return true
      } catch (err) {
        if (seq !== requestSeq) return false
        const data =
          err instanceof FsError
            ? err.toData()
            : {
                code: 'EUNKNOWN' as const,
                message: err instanceof Error ? err.message : String(err)
              }
        set({ loading: false, error: data })
        return false
      }
    }

    function recompute(patch: Partial<ColumnState>): void {
      const s = { ...get(), ...patch }
      const visible = computeVisible(s.entries, s.showHidden, s.sortKey, s.sortDir)
      const paths = new Set(visible.map((e) => e.path))
      set({
        ...patch,
        visible,
        selected: new Set([...s.selected].filter((p) => paths.has(p))),
        cursor: s.cursor && paths.has(s.cursor) ? s.cursor : (visible[0]?.path ?? null),
        anchor: s.anchor && paths.has(s.anchor) ? s.anchor : null
      })
    }

    function indexOf(path: string | null): number {
      return path === null ? -1 : get().visible.findIndex((e) => e.path === path)
    }

    /** Move the cursor to `index`; `extend` grows the selection from the anchor instead of resetting it. */
    function placeCursor(index: number, extend: boolean): void {
      const { visible, anchor } = get()
      const target = visible[Math.max(0, Math.min(visible.length - 1, index))]
      if (!target) return
      if (!extend) {
        set({ cursor: target.path, anchor: target.path, selected: new Set([target.path]) })
        return
      }
      const from = Math.max(0, indexOf(anchor ?? get().cursor))
      const to = visible.indexOf(target)
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      set({
        cursor: target.path,
        anchor: visible[from]?.path ?? target.path,
        selected: new Set(visible.slice(lo, hi + 1).map((e) => e.path))
      })
    }

    return {
      machineId,
      home: null,
      cwd: null,
      history: [],
      historyIndex: -1,
      entries: [],
      visible: [],
      loading: false,
      error: null,
      showHidden: false,
      sortKey: 'name',
      sortDir: 'asc',
      selected: new Set(),
      cursor: null,
      anchor: null,

      async init() {
        try {
          const home = await fs.home(machineId)
          set({ home })
          await load(home, 'push')
        } catch (err) {
          set({
            error:
              err instanceof FsError ? err.toData() : { code: 'EUNKNOWN', message: String(err) }
          })
        }
      },

      async navigate(input) {
        const { cwd, home } = get()
        const path = resolveInput(input, cwd ?? home ?? '/', home ?? '/')
        return load(path, 'push')
      },

      async back() {
        const { history, historyIndex, cwd } = get()
        const path = history[historyIndex - 1]
        if (path === undefined) return
        const ok = await load(path, 'keep', { cursor: cwd })
        if (ok) set({ historyIndex: historyIndex - 1 })
      },

      async forward() {
        const { history, historyIndex } = get()
        const path = history[historyIndex + 1]
        if (path === undefined) return
        const ok = await load(path, 'keep')
        if (ok) set({ historyIndex: historyIndex + 1 })
      },

      async up() {
        const { cwd } = get()
        if (cwd === null || cwd === '/') return
        await load(parentOf(cwd), 'push', { cursor: cwd })
      },

      async refresh() {
        const { cwd } = get()
        if (cwd !== null) await load(cwd, 'keep', { keepSelection: true })
      },

      async open(entry) {
        if (isDirLike(entry)) await load(entry.path, 'push')
      },

      async openCursor() {
        const entry = get().visible[indexOf(get().cursor)]
        if (entry) await get().open(entry)
      },

      clearError() {
        set({ error: null })
      },

      toggleHidden() {
        recompute({ showHidden: !get().showHidden })
      },

      setSort(key) {
        const { sortKey, sortDir } = get()
        if (key === sortKey) recompute({ sortDir: sortDir === 'asc' ? 'desc' : 'asc' })
        // Sizes and dates are most useful biggest/newest first; names read A to Z.
        else recompute({ sortKey: key, sortDir: key === 'name' || key === 'mode' ? 'asc' : 'desc' })
      },

      selectOnly(path) {
        set({ selected: new Set([path]), cursor: path, anchor: path })
      },

      toggleSelect(path) {
        const selected = new Set(get().selected)
        if (!selected.delete(path)) selected.add(path)
        set({ selected, cursor: path, anchor: path })
      },

      selectRange(path) {
        placeCursor(indexOf(path), true)
      },

      selectAll() {
        set({ selected: new Set(get().visible.map((e) => e.path)) })
      },

      clearSelection() {
        set({ selected: new Set() })
      },

      moveCursor(delta, extend) {
        const { visible, cursor } = get()
        if (visible.length === 0) return
        const current = indexOf(cursor)
        placeCursor(current === -1 ? (delta > 0 ? 0 : visible.length - 1) : current + delta, extend)
      },

      cursorTo(where, extend) {
        placeCursor(where === 'first' ? 0 : get().visible.length - 1, extend)
      }
    }
  })
}
