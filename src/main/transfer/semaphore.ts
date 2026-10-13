/** A counting semaphore whose waiters can be cancelled with an AbortSignal. */
export class Semaphore {
  private available: number
  private readonly waiters: { resolve: () => void; reject: (e: unknown) => void }[] = []

  constructor(permits: number) {
    this.available = permits
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.available > 0) {
      this.available--
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        },
        reject
      }
      const onAbort = (): void => {
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(signal!.reason)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) next.resolve()
    else this.available++
  }
}
