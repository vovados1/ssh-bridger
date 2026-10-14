/** A counting semaphore whose waiters can be cancelled with an AbortSignal. */
export class Semaphore {
  private available: number
  private readonly waiters: { resolve: () => void; reject: (e: unknown) => void }[] = []

  constructor(permits: number) {
    this.available = permits
  }

  /** Change the number of permits. Holders keep theirs; a smaller limit takes effect as they release. */
  resize(delta: number): void {
    this.available += delta
    while (this.available > 0 && this.waiters.length > 0) {
      this.available--
      this.waiters.shift()!.resolve()
    }
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
    this.available++
    if (this.available > 0) {
      const next = this.waiters.shift()
      if (next) {
        this.available--
        next.resolve()
      }
    }
  }
}
