import { Readable, Writable } from 'node:stream'
import type { SFTPWrapper } from 'ssh2'

/**
 * Streams over SFTP that keep many requests in flight. A plain request-per-chunk loop spends
 * almost all its time waiting for round trips (32 KB per RTT), so on a 40 ms link it would
 * crawl at under 1 MB/s. Pipelining 64 requests hides the latency, like `sftp`'s own get/put.
 */

/** Bytes per SFTP request. Servers cap requests around 256 KB; 32 KB is universally safe. */
export const SFTP_CHUNK = 32 * 1024
/** Requests allowed in flight at once per stream. */
export const SFTP_CONCURRENCY = 64

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

/**
 * When the connection drops, ssh2 simply never answers the requests still in flight, which
 * would leave a transfer waiting forever. Watch the channel and fail the stream instead.
 * Returns a function that stops watching.
 */
function failOnChannelLoss(sftp: SFTPWrapper, stream: Readable | Writable): () => void {
  const lost = (): void => {
    stream.destroy(new Error('The connection was lost during the transfer'))
  }
  sftp.once('close', lost)
  sftp.once('end', lost)
  sftp.once('error', lost)
  return () => {
    sftp.removeListener('close', lost)
    sftp.removeListener('end', lost)
    sftp.removeListener('error', lost)
  }
}

/**
 * Reads a file of known `size` with up to `concurrency` reads outstanding, delivering the
 * chunks in order. Memory is bounded by `concurrency * chunk` per stream.
 */
export class SftpReadStream extends Readable {
  private nextOffset: number
  private nextIndex = 0
  private emitIndex = 0
  private readonly ready = new Map<number, Buffer>()
  private inflight = 0
  private ended = false
  /** The consumer has room: set by `_read`, cleared when `push` says it is full. */
  private wanting = false
  private readonly stopWatching: () => void

  constructor(
    private readonly sftp: SFTPWrapper,
    private readonly handle: Buffer,
    private readonly size: number,
    start = 0,
    private readonly chunk = SFTP_CHUNK,
    private readonly concurrency = SFTP_CONCURRENCY
  ) {
    super({ highWaterMark: chunk * 4 })
    this.nextOffset = start
    this.stopWatching = failOnChannelLoss(sftp, this)
  }

  override _read(): void {
    this.wanting = true
    this.pump()
  }

  override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    this.stopWatching()
    this.ready.clear()
    // On a dead channel the close never answers; don't wait for it.
    if (err) this.sftp.close(this.handle, () => {})
    if (err) callback(err)
    else this.sftp.close(this.handle, () => callback(null))
  }

  private pump(): void {
    if (this.destroyed || this.ended) return

    // Hand over finished chunks in file order, but only while the consumer wants more. Pushing
    // regardless (this runs on every completed read, not only on `_read`) would buffer the whole
    // file in memory whenever the destination is slower than the network.
    while (this.wanting && this.ready.has(this.emitIndex)) {
      const buf = this.ready.get(this.emitIndex)!
      this.ready.delete(this.emitIndex)
      this.emitIndex++
      if (!this.push(buf)) this.wanting = false
    }

    if (this.nextOffset >= this.size && this.inflight === 0 && this.ready.size === 0) {
      this.ended = true
      this.push(null)
      return
    }

    // Keep the window full, but never read further ahead than we can buffer.
    while (this.nextOffset < this.size && this.inflight + this.ready.size < this.concurrency) {
      const index = this.nextIndex++
      const length = Math.min(this.chunk, this.size - this.nextOffset)
      const position = this.nextOffset
      this.nextOffset += length
      this.inflight++
      const buffer = Buffer.allocUnsafe(length)
      this.sftp.read(this.handle, buffer, 0, length, position, (err, bytesRead) => {
        this.inflight--
        if (this.destroyed) return
        if (err) return this.destroy(asError(err))
        if (bytesRead !== length) {
          return this.destroy(
            new Error(`Short read at byte ${position}: the file changed while reading`)
          )
        }
        this.ready.set(index, buffer)
        this.pump()
      })
    }
  }
}

/**
 * Writes sequential chunks at increasing offsets with up to `concurrency` writes outstanding.
 * `write` calls back as soon as a chunk is dispatched (not acknowledged) while the window has
 * room; `final` waits for every acknowledgement, so a successful `end` means the data landed.
 */
export class SftpWriteStream extends Writable {
  private offset = 0
  private inflight = 0
  private release: (() => void) | undefined
  private finish: (() => void) | undefined
  private readonly stopWatching: () => void

  constructor(
    private readonly sftp: SFTPWrapper,
    private readonly handle: Buffer,
    private readonly concurrency = SFTP_CONCURRENCY
  ) {
    super({ highWaterMark: SFTP_CHUNK * 4 })
    this.stopWatching = failOnChannelLoss(sftp, this)
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    for (let at = 0; at < chunk.length; at += SFTP_CHUNK) {
      const piece = chunk.subarray(at, Math.min(at + SFTP_CHUNK, chunk.length))
      const position = this.offset
      this.offset += piece.length
      this.inflight++
      this.sftp.write(this.handle, piece, 0, piece.length, position, (err) => {
        this.inflight--
        if (this.destroyed) return
        if (err) return this.destroy(asError(err))
        this.settle()
      })
    }
    if (this.inflight < this.concurrency) callback()
    else this.release = callback
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.inflight === 0) callback()
    else this.finish = callback
  }

  override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    this.stopWatching()
    this.release = undefined
    this.finish = undefined
    if (err) {
      this.sftp.close(this.handle, () => {})
      callback(err)
    } else {
      this.sftp.close(this.handle, () => callback(null))
    }
  }

  private settle(): void {
    if (this.release && this.inflight < this.concurrency) {
      const cb = this.release
      this.release = undefined
      cb()
    }
    if (this.finish && this.inflight === 0) {
      const cb = this.finish
      this.finish = undefined
      cb()
    }
  }
}
