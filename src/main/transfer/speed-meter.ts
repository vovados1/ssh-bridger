/** Transfer speed averaged over a short sliding window, so the number is steady but not stale. */
export class SpeedMeter {
  private samples: { at: number; bytes: number }[] = []

  constructor(private readonly windowMs = 3000) {}

  /** Record the running total of bytes transferred at time `at`. */
  record(totalBytes: number, at: number): void {
    const last = this.samples.at(-1)
    // Coalesce bursts: one sample per ~50 ms is plenty and keeps this array small.
    if (last && at - last.at < 50) last.bytes = totalBytes
    else this.samples.push({ at, bytes: totalBytes })
    const cutoff = at - this.windowMs
    while (this.samples.length > 2 && this.samples[1]!.at <= cutoff) this.samples.shift()
  }

  /** Bytes per second; 0 when there is not enough data or nothing moved recently. */
  speed(now: number): number {
    const first = this.samples[0]
    const last = this.samples.at(-1)
    if (!first || !last || last === first) return 0
    // If nothing arrived for a while the speed is decaying, not frozen at its old value.
    const span = Math.max(now, last.at) - first.at
    return span > 0 ? Math.max(0, (last.bytes - first.bytes) / (span / 1000)) : 0
  }

  reset(): void {
    this.samples = []
  }
}
