import { Server, utils, type AuthenticationType, type Connection, type ParsedKey } from 'ssh2'

export interface AuthServerOptions {
  /** Accept this password. */
  password?: string
  /** Offer keyboard-interactive with these prompts, accepting these answers. */
  keyboard?: { prompts: { prompt: string; echo: boolean }[]; answers: string[] }
}

export interface AuthServer {
  port: number
  /** `ssh-ed25519 AAAA...` host key line. */
  hostKeyLine: string
  /** Every authentication attempt the server saw, in order. */
  attempts: string[]
  stop(): Promise<void>
}

/**
 * An in-process SSH server that only authenticates (no shell, no SFTP). OpenSSH can't
 * authenticate by password as an unprivileged user, so this covers password and
 * keyboard-interactive flows.
 */
export async function startAuthServer(options: AuthServerOptions): Promise<AuthServer> {
  const hostKey = utils.generateKeyPairSync('ed25519')
  const attempts: string[] = []
  const clients = new Set<Connection>()

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) => {
      attempts.push(ctx.method)
      if (ctx.method === 'password' && options.password !== undefined) {
        return ctx.password === options.password ? ctx.accept() : ctx.reject(methods(options))
      }
      if (ctx.method === 'keyboard-interactive' && options.keyboard) {
        const { prompts, answers } = options.keyboard
        return ctx.prompt(prompts, 'Test server', 'Answer the questions', (given) =>
          given.length === answers.length && given.every((a, i) => a === answers[i])
            ? ctx.accept()
            : ctx.reject(methods(options))
        )
      }
      ctx.reject(methods(options))
    })
    client.on('error', () => {})
    client.on('ready', () => {
      client.on('session', (accept) => accept())
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const pub = utils.parseKey(hostKey.public)
  const parsed = Array.isArray(pub) ? pub[0]! : (pub as ParsedKey)

  return {
    port,
    hostKeyLine: `${parsed.type} ${parsed.getPublicSSH().toString('base64')}`,
    attempts,
    stop: () =>
      new Promise((resolve) => {
        for (const c of clients) c.end()
        server.close(() => resolve())
      })
  }
}

function methods(o: AuthServerOptions): AuthenticationType[] {
  const list: AuthenticationType[] = []
  if (o.password !== undefined) list.push('password')
  if (o.keyboard) list.push('keyboard-interactive')
  return list
}
