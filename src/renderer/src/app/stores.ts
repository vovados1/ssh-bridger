import { useStore } from 'zustand'
import {
  createConnectionsStore,
  type ConnectionsState
} from '../features/connections/connectionsStore'
import { refreshColumnsShowing } from '../features/column/columnRegistry'
import { createTransfersStore, type TransfersState } from '../features/transfers/transfersStore'
import { TransferRefresher } from '../features/transfers/transferRefresh'
import { createSettingsStore, type SettingsState } from '../features/settings/settingsStore'
import { connectionsClient, settingsClient, transfersClient } from '../lib/api'
import { notify } from '../lib/toasts'
import { createWorkspaceStore, type WorkspaceState } from './workspaceStore'

/** The app's two long-lived stores. Components reach them through these hooks. */
export const connectionsStore = createConnectionsStore(connectionsClient)
export const transfersStore = createTransfersStore(transfersClient, notify)
export const settingsStore = createSettingsStore(settingsClient, notify)
export const workspaceStore = createWorkspaceStore({
  connections: connectionsStore,
  notify,
  layout: { load: transfersClient.loadLayout, save: transfersClient.saveLayout }
})

// Finished (and progressing) transfers change folders that may be on screen; reload those columns.
const refresher = new TransferRefresher(refreshColumnsShowing)
transfersStore.subscribe((state, previous) => {
  if (state.jobs !== previous.jobs) refresher.update(state.jobs)
})

export function useConnections<T>(selector: (state: ConnectionsState) => T): T {
  return useStore(connectionsStore, selector)
}

export function useWorkspace<T>(selector: (state: WorkspaceState) => T): T {
  return useStore(workspaceStore, selector)
}

export function useTransfers<T>(selector: (state: TransfersState) => T): T {
  return useStore(transfersStore, selector)
}

export function useSettings<T>(selector: (state: SettingsState) => T): T {
  return useStore(settingsStore, selector)
}
