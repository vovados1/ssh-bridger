export interface Coalescer {
  /** Note that something changed; `fn` will run once the burst settles. */
  trigger(): void
  cancel(): void
}

/**
 * Collapse a burst of triggers into one call: `fn` runs `quietMs` after the last trigger,
 * but never later than `maxWaitMs` after the first, so a constantly changing folder
 * still refreshes now and then instead of starving.
 */
export function coalesce(fn: () => void, quietMs: number, maxWaitMs: number): Coalescer {
  let timer: ReturnType<typeof setTimeout> | undefined
  let firstAt = 0

  const fire = (): void => {
    timer = undefined
    fn()
  }

  return {
    trigger() {
      const now = Date.now()
      if (timer === undefined) firstAt = now
      else clearTimeout(timer)
      timer = setTimeout(fire, Math.max(0, Math.min(quietMs, firstAt + maxWaitMs - now)))
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
  }
}
