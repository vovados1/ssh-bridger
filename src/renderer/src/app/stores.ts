import { useStore } from 'zustand'
import {
  createConnectionsStore,
  type ConnectionsState
} from '../features/connections/connectionsStore'
import { connectionsClient } from '../lib/api'
import { notify } from '../lib/toasts'
import { createWorkspaceStore, type WorkspaceState } from './workspaceStore'

/** The app's two long-lived stores. Components reach them through these hooks. */
export const connectionsStore = createConnectionsStore(connectionsClient)
export const workspaceStore = createWorkspaceStore({ connections: connectionsStore, notify })

export function useConnections<T>(selector: (state: ConnectionsState) => T): T {
  return useStore(connectionsStore, selector)
}

export function useWorkspace<T>(selector: (state: WorkspaceState) => T): T {
  return useStore(workspaceStore, selector)
}
