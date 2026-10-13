import { createStore, type StoreApi } from 'zustand/vanilla'
import { sshMachineId, type ConnectionProfile } from '@shared/connections'
import type { FsError, MachineId } from '@shared/fs-types'
import {
  DEFAULT_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  type Layout,
  type LayoutColumn
} from '@shared/layout'
import type { ColumnInitial } from '../features/column/columnStore'
import type { SortDir, SortKey } from '../features/column/sort'
import type { ConnectionsStore } from '../features/connections/connectionsStore'
import type { Notify } from '../lib/toasts'

export interface WorkspaceColumn {
  id: string
  machineId: MachineId
  title: string
  /** Set for remote columns. */
  profileId?: string
  color?: string
  /** Width in CSS pixels. */
  width: number
  /** Folder and view settings the column starts with (restored from the saved layout). */
  initial?: ColumnInitial
}

/** The part of a column's state worth remembering between runs. */
export interface ColumnView {
  cwd: string | null
  showHidden: boolean
  sortKey: SortKey
  sortDir: SortDir
}

/** What is open on top of the columns. */
export type Dialog =
  | { kind: 'profile'; profileId?: string; connectAfterSave?: boolean }
  | { kind: 'manage' }
  | { kind: 'import' }
  | { kind: 'connectError'; profileName: string; error: FsError }

export interface WorkspaceState {
  columns: WorkspaceColumn[]
  dialog: Dialog | null
  /** Profiles with a connection attempt in flight, so a double click does not start two. */
  connecting: ReadonlySet<string>
  /** True once the saved layout has been read (or found missing); saving waits for this. */
  restored: boolean

  /** Load the saved layout and rebuild the columns from it. Call after profiles are loaded. */
  restore(): Promise<void>
  /** Connect if needed, then open a column for the profile. */
  openRemote(profileId: string): Promise<void>
  /** Try again after a lost connection, without opening another column. */
  reconnect(profileId: string): Promise<void>
  addLocalColumn(): void
  closeColumn(id: string): void
  /** Put column `id` at position `index` in the row. */
  moveColumn(id: string, index: number): void
  setColumnWidth(id: string, width: number): void
  updateColumnView(id: string, view: ColumnView): void
  showDialog(dialog: Dialog | null): void
}

export type WorkspaceStore = StoreApi<WorkspaceState>

export interface WorkspaceDeps {
  connections: ConnectionsStore
  notify: Notify
  layout: {
    load(): Promise<Layout | null>
    save(layout: Layout): Promise<void>
  }
  newId?: () => string
  /** Layout saves are batched; dragging a splitter would otherwise write on every pixel. */
  saveDelayMs?: number
}

const LOCAL_ID = 'local'

export function toLayout(
  columns: readonly WorkspaceColumn[],
  views: ReadonlyMap<string, ColumnView>
): Layout {
  return {
    columns: columns.map((c): LayoutColumn => {
      const view = views.get(c.id)
      const cwd = view?.cwd ?? c.initial?.path
      return {
        id: c.id,
        machineId: c.machineId,
        ...(c.profileId ? { profileId: c.profileId } : {}),
        width: c.width,
        ...(cwd ? { cwd } : {}),
        showHidden: view?.showHidden ?? c.initial?.showHidden ?? false,
        sortKey: view?.sortKey ?? c.initial?.sortKey ?? 'name',
        sortDir: view?.sortDir ?? c.initial?.sortDir ?? 'asc'
      }
    })
  }
}

export function createWorkspaceStore({
  connections,
  notify,
  layout,
  newId = () => crypto.randomUUID(),
  saveDelayMs = 500
}: WorkspaceDeps): WorkspaceStore {
  /** Latest view of each column, kept apart from `columns` so scrolling around doesn't rebuild them. */
  const views = new Map<string, ColumnView>()
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  const localColumn = (id = LOCAL_ID): WorkspaceColumn => ({
    id,
    machineId: 'local',
    title: 'Local',
    width: DEFAULT_COLUMN_WIDTH
  })

  const columnFor = (profile: ConnectionProfile): WorkspaceColumn => ({
    id: newId(),
    machineId: sshMachineId(profile.id),
    title: profile.name,
    profileId: profile.id,
    width: DEFAULT_COLUMN_WIDTH,
    ...(profile.color ? { color: profile.color } : {})
  })

  const scheduleSave = (): void => {
    if (!store.getState().restored) return // never overwrite a saved layout before reading it
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      void layout.save(toLayout(store.getState().columns, views)).catch(() => {})
    }, saveDelayMs)
  }

  const store: WorkspaceStore = createStore<WorkspaceState>()((set, get) => ({
    columns: [localColumn()],
    dialog: null,
    connecting: new Set(),
    restored: false,

    async restore() {
      let saved: Layout | null = null
      try {
        saved = await layout.load()
      } catch {
        /* an unreadable layout just means the default one */
      }
      if (saved && saved.columns.length > 0) {
        const profiles = new Map(connections.getState().profiles.map((p) => [p.id, p]))
        const columns = saved.columns.flatMap((c): WorkspaceColumn[] => {
          const initial: ColumnInitial = {
            ...(c.cwd ? { path: c.cwd } : {}),
            ...(c.showHidden !== undefined ? { showHidden: c.showHidden } : {}),
            ...(c.sortKey ? { sortKey: c.sortKey } : {}),
            ...(c.sortDir ? { sortDir: c.sortDir } : {})
          }
          const width = Math.max(MIN_COLUMN_WIDTH, c.width ?? DEFAULT_COLUMN_WIDTH)
          if (c.profileId === undefined) {
            return [{ id: c.id, machineId: 'local', title: 'Local', width, initial }]
          }
          const profile = profiles.get(c.profileId)
          if (!profile) return [] // the connection was deleted since
          return [{ ...columnFor(profile), id: c.id, width, initial }]
        })
        if (columns.length > 0) set({ columns })
      }
      set({ restored: true })
      scheduleSave()
    },

    async openRemote(profileId) {
      const profile = connections.getState().profiles.find((p) => p.id === profileId)
      if (!profile) return
      if (get().connecting.has(profileId)) return

      const status = connections.getState().states[profileId]?.status
      if (status !== 'connected') {
        set({ connecting: new Set([...get().connecting, profileId]) })
        const error = await connections.getState().connect(profileId)
        const rest = new Set(get().connecting)
        rest.delete(profileId)
        set({ connecting: rest })

        if (error) {
          if (error.code === 'ECANCELLED') return // the user backed out; nothing to report
          if (error.code === 'EHOSTKEY') {
            // A distrusted host key deserves more than a toast that disappears.
            set({ dialog: { kind: 'connectError', profileName: profile.name, error } })
          } else {
            notify({ kind: 'error', message: `${profile.name}: ${error.message}` })
          }
          return
        }
      }
      set({ columns: [...get().columns, columnFor(profile)] })
    },

    async reconnect(profileId) {
      const profile = connections.getState().profiles.find((p) => p.id === profileId)
      const error = await connections.getState().connect(profileId)
      if (!error || error.code === 'ECANCELLED') return
      if (error.code === 'EHOSTKEY') {
        set({ dialog: { kind: 'connectError', profileName: profile?.name ?? profileId, error } })
      } else {
        notify({ kind: 'error', message: `${profile?.name ?? profileId}: ${error.message}` })
      }
    },

    addLocalColumn() {
      set({ columns: [...get().columns, localColumn(newId())] })
    },

    closeColumn(id) {
      if (get().columns.length <= 1) return // always keep one column on screen
      views.delete(id)
      set({ columns: get().columns.filter((c) => c.id !== id) })
    },

    moveColumn(id, index) {
      const columns = [...get().columns]
      const from = columns.findIndex((c) => c.id === id)
      if (from < 0) return
      const [column] = columns.splice(from, 1)
      columns.splice(Math.max(0, Math.min(columns.length, index)), 0, column!)
      set({ columns })
    },

    setColumnWidth(id, width) {
      const clamped = Math.max(MIN_COLUMN_WIDTH, Math.round(width))
      set({ columns: get().columns.map((c) => (c.id === id ? { ...c, width: clamped } : c)) })
    },

    updateColumnView(id, view) {
      views.set(id, view)
      scheduleSave()
    },

    showDialog(dialog) {
      set({ dialog })
    }
  }))

  // Columns follow their profile: renaming retitles them, deleting a profile closes them.
  connections.subscribe((state, previous) => {
    if (state.profiles === previous.profiles) return
    const byId = new Map(state.profiles.map((p) => [p.id, p]))
    const columns = store.getState().columns.flatMap((c) => {
      if (c.profileId === undefined) return [c]
      const profile = byId.get(c.profileId)
      if (!profile) return []
      const next: WorkspaceColumn = { ...c, title: profile.name }
      if (profile.color) next.color = profile.color
      else delete next.color
      return [next]
    })
    if (columns.length > 0) store.setState({ columns })
  })

  // Anything that changes the arrangement is worth saving.
  store.subscribe((state, previous) => {
    if (state.columns !== previous.columns) scheduleSave()
  })

  return store
}
