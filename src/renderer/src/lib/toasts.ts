import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

export type ToastKind = 'error' | 'info'

export interface Notification {
  kind: ToastKind
  message: string
}

/** How the stores report something to the user without depending on any UI. */
export type Notify = (notification: Notification) => void

export interface Toast extends Notification {
  id: number
}

interface ToastState {
  toasts: Toast[]
  push(notification: Notification): void
  dismiss(id: number): void
}

const LIFETIME_MS: Record<ToastKind, number> = { info: 4000, error: 8000 }

let nextId = 1

export const toastStore = createStore<ToastState>()((set, get) => ({
  toasts: [],
  push(notification) {
    // A watcher or a repeated failure can raise the same message again and again.
    if (
      get().toasts.some((t) => t.kind === notification.kind && t.message === notification.message)
    )
      return
    const id = nextId++
    set({ toasts: [...get().toasts, { ...notification, id }] })
    setTimeout(() => get().dismiss(id), LIFETIME_MS[notification.kind])
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  }
}))

export const notify: Notify = (n) => toastStore.getState().push(n)

export function useToasts(): Toast[] {
  return useStore(toastStore, (s) => s.toasts)
}
