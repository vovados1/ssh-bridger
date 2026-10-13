import { createStore, type StoreApi } from 'zustand/vanilla'
import { sshMachineId, type ConnectionProfile } from '@shared/connections'
import type { FsError, MachineId } from '@shared/fs-types'
import type { ConnectionsStore } from '../features/connections/connectionsStore'
import type { Notify } from '../lib/toasts'

export interface WorkspaceColumn {
  id: string
  machineId: MachineId
  title: string
  /** Set for remote columns. */
  profileId?: string
  color?: string
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

  /** Connect if needed, then open a column for the profile. */
  openRemote(profileId: string): Promise<void>
  /** Try again after a lost connection, without opening another column. */
  reconnect(profileId: string): Promise<void>
  closeColumn(id: string): void
  showDialog(dialog: Dialog | null): void
}

export type WorkspaceStore = StoreApi<WorkspaceState>

export interface WorkspaceDeps {
  connections: ConnectionsStore
  notify: Notify
  newId?: () => string
}

export function createWorkspaceStore({
  connections,
  notify,
  newId = () => crypto.randomUUID()
}: WorkspaceDeps): WorkspaceStore {
  const LOCAL: WorkspaceColumn = { id: 'local', machineId: 'local', title: 'Local' }

  const columnFor = (profile: ConnectionProfile): WorkspaceColumn => ({
    id: newId(),
    machineId: sshMachineId(profile.id),
    title: profile.name,
    profileId: profile.id,
    ...(profile.color ? { color: profile.color } : {})
  })

  const store = createStore<WorkspaceState>()((set, get) => ({
    columns: [LOCAL],
    dialog: null,
    connecting: new Set(),

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

    closeColumn(id) {
      if (id === LOCAL.id) return // the local machine is always there
      set({ columns: get().columns.filter((c) => c.id !== id) })
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
    store.setState({ columns })
  })

  return store
}
