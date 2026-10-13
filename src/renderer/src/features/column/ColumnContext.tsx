import { createContext, useContext } from 'react'
import { useStore } from 'zustand'
import type { ColumnState, ColumnStore } from './columnStore'

export const ColumnContext = createContext<ColumnStore | null>(null)

/** Subscribe to the enclosing column's store. */
export function useColumn<T>(selector: (state: ColumnState) => T): T {
  const store = useContext(ColumnContext)
  if (!store) throw new Error('useColumn must be used inside <Column>')
  return useStore(store, selector)
}

/** The store itself, for imperative reads in event handlers. */
export function useColumnStore(): ColumnStore {
  const store = useContext(ColumnContext)
  if (!store) throw new Error('useColumnStore must be used inside <Column>')
  return store
}
