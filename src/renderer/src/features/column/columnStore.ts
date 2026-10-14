import { createStore, type StoreApi } from 'zustand/vanilla'
import {
  FsError,
  isDirLike,
  type Entry,
  type EntryDetails,
  type FsErrorData,
  type MachineId
} from '@shared/fs-types'
import { nameProblem, uniqueName } from '@shared/names'
import { joinPath, parentOf, resolveInput } from '@shared/posix-path'
import type { FsClient } from '../../lib/fs-client'
import type { Notify } from '../../lib/toasts'
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
  /** Path of the entry whose name is being edited inline. */
  renaming: string | null

  /**
   * Open the starting folder. Safe to call again (e.g. after a reconnect): a column that
   * already shows something just resumes watching it and reloads.
   */
  init(): Promise<void>
  /** Go to a typed or clicked path. `~` and relative paths are resolved. */
  navigate(input: string): Promise<boolean>
  back(): Promise<void>
  forward(): Promise<void>
  up(): Promise<void>
  refresh(): Promise<void>
  /**
   * Re-read the folder in the background, for machines that can't announce changes. Shows no
   * spinner, stays silent on failure and leaves everything alone unless the listing changed.
   */
  poll(): Promise<void>
  open(entry: Entry): Promise<void>
  openCursor(): Promise<void>
  clearError(): void
  /** Stop watching and listening; call when the column goes away. */
  dispose(): void

  toggleHidden(): void
  setSort(key: SortKey): void

  selectOnly(path: string): void
  toggleSelect(path: string): void
  selectRange(path: string): void
  selectAll(): void
  clearSelection(): void
  moveCursor(delta: number, extend: boolean): void
  cursorTo(where: 'first' | 'last', extend: boolean): void

  /** Selected entries in list order. */
  selectedEntries(): Entry[]
  /** Create "New Folder"/"New File" here, select it and start renaming it. */
  create(kind: 'folder' | 'file'): Promise<void>
  startRename(path?: string): void
  cancelRename(): void
  /** False (and still renaming) when the new name is invalid or taken. */
  commitRename(newName: string): Promise<boolean>
  remove(paths: string[], options: { permanent: boolean }): Promise<void>
  chmod(paths: string[], mode: number): Promise<void>
  details(path: string): Promise<EntryDetails>
}

/** Where a column starts, restored from the saved layout. */
export interface ColumnInitial {
  /** Folder to open instead of home; quietly falls back to home if it is gone. */
  path?: string
  showHidden?: boolean
  sortKey?: SortKey
  sortDir?: SortDir
}

export interface ColumnStoreOptions {
  machineId: MachineId
  fs: FsClient
  notify: Notify
  initial?: ColumnInitial
  /** Names this column's watch so main can tell columns apart. */
  watchKey?: string
}

export type ColumnStore = StoreApi<ColumnState>

type HistoryMode = 'push' | 'keep'

/** Whether two listings show the same thing, so an unchanged poll doesn't redraw anything. */
function sameListing(a: Entry[], b: Entry[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b)
}

function errorData(err: unknown): FsErrorData {
  return err instanceof FsError
    ? err.toData()
    : { code: 'EUNKNOWN', message: err instanceof Error ? err.message : String(err) }
}

export function createColumnStore({
  machineId,
  fs,
  notify,
  initial = {},
  watchKey = 'column'
}: ColumnStoreOptions): ColumnStore {
  /** Only the latest listing request may apply its result; older ones are stale. */
  let requestSeq = 0
  let unsubscribe: (() => void) | undefined

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
        return apply(path, entries, history, opts)
      } catch (err) {
        if (seq !== requestSeq) return false
        set({ loading: false, error: errorData(err) })
        return false
      }
    }

    /** Make a fresh listing the current one. */
    function apply(
      path: string,
      entries: Entry[],
      history: HistoryMode,
      opts: { cursor?: string | null; keepSelection?: boolean }
    ): boolean {
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

      const renaming = s.renaming && paths.has(s.renaming) ? s.renaming : null
      const folderChanged = path !== s.cwd

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
        renaming,
        history: hist,
        historyIndex,
        loading: false,
        error: null
      })
      // Fire and forget: if live updates aren't available, manual refresh still works.
      if (folderChanged) void fs.watch(machineId, path, watchKey).catch(() => {})
      return true
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
      showHidden: initial.showHidden ?? false,
      sortKey: initial.sortKey ?? 'name',
      sortDir: initial.sortDir ?? 'asc',
      selected: new Set(),
      cursor: null,
      anchor: null,
      renaming: null,

      async init() {
        unsubscribe?.()
        unsubscribe = fs.onChanged((key) => {
          if (key === watchKey) void get().refresh()
        })
        const showing = get().cwd
        if (showing !== null) {
          // Resuming (the connection came back): watch the folder again and show what is there now.
          void fs.watch(machineId, showing, watchKey).catch(() => {})
          await get().refresh()
          return
        }
        const startedAt = requestSeq
        try {
          const home = await fs.home(machineId)
          set({ home })
          // On a slow machine the user can navigate before home resolves; their choice wins.
          if (requestSeq !== startedAt) return
          const wanted = initial.path
          if (wanted !== undefined && wanted !== home) {
            if (await load(wanted, 'push')) return
            if (requestSeq !== startedAt + 1) return // the user went somewhere else meanwhile
            set({ error: null }) // the saved folder is gone: fall back to home without complaint
          }
          await load(home, 'push')
        } catch (err) {
          set({ error: errorData(err) })
        }
      },

      dispose() {
        unsubscribe?.()
        unsubscribe = undefined
        void fs.unwatch(watchKey).catch(() => {})
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
        if (cwd === null) return
        if (await load(cwd, 'keep', { keepSelection: true })) return
        if (get().error?.code !== 'ENOENT') return
        // The folder we were showing was deleted or renamed away: fall back to the nearest one that exists.
        for (let dir = parentOf(cwd); ; dir = parentOf(dir)) {
          if (await load(dir, 'push')) {
            notify({ kind: 'info', message: `"${cwd}" no longer exists; moved to "${dir}"` })
            return
          }
          if (dir === '/' || get().error?.code !== 'ENOENT') return
        }
      },

      async poll() {
        const { cwd, entries: before, loading, renaming } = get()
        // Don't compete with a load in progress, or move rows under someone who is typing a name.
        if (cwd === null || loading || renaming !== null) return
        const seq = requestSeq // not incremented: a poll must never invalidate the user's navigation
        try {
          const entries = await fs.list(machineId, cwd)
          if (seq !== requestSeq || get().cwd !== cwd || get().renaming !== null) return
          if (sameListing(before, entries)) return
          apply(cwd, entries, 'keep', { keepSelection: true })
        } catch {
          // Offline or the folder is gone: the next real action reports it.
        }
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
      },

      selectedEntries() {
        const { visible, selected } = get()
        return visible.filter((e) => selected.has(e.path))
      },

      async create(kind) {
        const { cwd, entries } = get()
        if (cwd === null) return
        const base = kind === 'folder' ? 'New Folder' : 'New File'
        const taken = new Set(entries.map((e) => e.name))
        // Another process may grab the name between the listing and the create; just take the next one.
        for (let attempt = 0; attempt < 5; attempt++) {
          const path = joinPath(cwd, uniqueName(base, taken))
          try {
            await (kind === 'folder' ? fs.mkdir(machineId, path) : fs.createFile(machineId, path))
          } catch (err) {
            if (err instanceof FsError && err.code === 'EEXIST') {
              taken.add(path.slice(cwd.length + (cwd === '/' ? 0 : 1)))
              continue
            }
            notify({ kind: 'error', message: errorData(err).message })
            return
          }
          if (get().cwd !== cwd) return // the user moved on; the new item is in the old folder
          await load(cwd, 'keep', { cursor: path })
          if (get().cursor === path) set({ renaming: path })
          return
        }
        notify({ kind: 'error', message: `Could not find a free name for the new ${kind}` })
      },

      startRename(path) {
        const target = path ?? get().cursor
        if (target !== null && get().visible.some((e) => e.path === target)) {
          set({ renaming: target, cursor: target, anchor: target, selected: new Set([target]) })
        }
      },

      cancelRename() {
        set({ renaming: null })
      },

      async commitRename(newName) {
        const { renaming, cwd, entries } = get()
        if (renaming === null || cwd === null) return false
        const oldName = renaming.slice(renaming.lastIndexOf('/') + 1)
        if (newName === oldName) {
          set({ renaming: null })
          return true
        }
        const problem = nameProblem(newName)
        if (problem !== null) {
          notify({ kind: 'error', message: problem })
          return false
        }
        if (entries.some((e) => e.name === newName)) {
          notify({ kind: 'error', message: `"${newName}" already exists` })
          return false
        }
        const target = joinPath(parentOf(renaming), newName)
        set({ renaming: null })
        try {
          await fs.rename(machineId, renaming, target)
        } catch (err) {
          notify({ kind: 'error', message: errorData(err).message })
          await get().refresh()
          return false
        }
        if (get().cwd === cwd) await load(cwd, 'keep', { cursor: target })
        return true
      },

      async remove(paths, { permanent }) {
        const { cwd, visible } = get()
        if (cwd === null || paths.length === 0) return
        const firstIndex = Math.min(
          ...paths.map((p) => visible.findIndex((e) => e.path === p)).filter((i) => i >= 0)
        )
        const failures: string[] = []
        for (const path of paths) {
          try {
            await fs.remove(machineId, path, { recursive: true, toTrash: !permanent })
          } catch (err) {
            failures.push(errorData(err).message)
          }
        }
        if (failures.length > 0) {
          notify({
            kind: 'error',
            message:
              paths.length === 1
                ? failures[0]!
                : `Could not delete ${failures.length} of ${paths.length} items: ${failures[0]}`
          })
        }
        if (get().cwd !== cwd) return
        if (await load(cwd, 'keep')) {
          // Land on the item that took the deleted one's place, like a file manager would.
          const next = get().visible[Math.min(firstIndex, get().visible.length - 1)]
          if (next && get().selected.size === 0) get().selectOnly(next.path)
        }
      },

      async chmod(paths, mode) {
        const failures: string[] = []
        for (const path of paths) {
          try {
            await fs.chmod(machineId, path, mode)
          } catch (err) {
            failures.push(errorData(err).message)
          }
        }
        if (failures.length > 0) {
          notify({
            kind: 'error',
            message:
              paths.length === 1
                ? failures[0]!
                : `Could not change ${failures.length} of ${paths.length} items: ${failures[0]}`
          })
        }
        await get().refresh()
      },

      details(path) {
        return fs.details(machineId, path)
      }
    }
  })
}
