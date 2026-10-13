import { createServer, connect, type Server, type Socket } from 'node:net'

export interface TcpProxy {
  port: number
  /** Sever every open connection, as a network drop would. */
  dropAll(): void
  /** Stop accepting new connections (existing ones are dropped too). */
  block(): Promise<void>
  /** Accept connections again on the same port. */
  unblock(): Promise<void>
  stop(): Promise<void>
}

/** A forwarder in front of a server so tests can cut the connection without touching the server. */
export async function startProxy(
  targetPort: number,
  /** Added to every chunk in each direction, simulating a slow link (round trip = 2x). */
  latencyMs = 0
): Promise<TcpProxy> {
  const sockets = new Set<Socket>()
  let server: Server | undefined

  const listen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const s = createServer((client) => {
        const upstream = connect(targetPort, '127.0.0.1')
        for (const sock of [client, upstream]) {
          sockets.add(sock)
          sock.on('close', () => sockets.delete(sock))
          sock.on('error', () => sock.destroy())
        }
        if (latencyMs > 0) {
          // Equal timers fire in creation order, so chunks stay in sequence.
          const relay = (from: Socket, to: Socket): void => {
            from.on('data', (chunk) => {
              setTimeout(() => {
                if (!to.destroyed) to.write(chunk)
              }, latencyMs)
            })
          }
          relay(client, upstream)
          relay(upstream, client)
        } else {
          client.pipe(upstream)
          upstream.pipe(client)
        }
        upstream.on('close', () => client.destroy())
        client.on('close', () => upstream.destroy())
      })
      s.once('error', reject)
      s.listen(port, '127.0.0.1', () => {
        server = s
        resolve((s.address() as { port: number }).port)
      })
    })

  const dropAll = (): void => {
    for (const s of sockets) s.destroy()
    sockets.clear()
  }
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      const s = server
      server = undefined
      if (!s) return resolve()
      s.close(() => resolve())
    })

  const port = await listen(0)
  return {
    port,
    dropAll,
    async block() {
      // Drop first: server.close() only completes once every connection has ended.
      dropAll()
      await close()
    },
    async unblock() {
      if (!server) await listen(port)
    },
    async stop() {
      dropAll()
      await close()
    }
  }
}
