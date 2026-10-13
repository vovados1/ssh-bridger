import { randomUUID } from 'node:crypto'
import type { PromptRequest, PromptResponse } from '@shared/connections'

/** A prompt as the connection code writes it; the broker assigns the id. */
export type NewPrompt = PromptRequest extends infer T
  ? T extends PromptRequest
    ? Omit<T, 'id'>
    : never
  : never

/** How the SSH code asks the user something. Resolves to null when they cancel (or nobody can answer). */
export interface Prompter {
  ask(prompt: NewPrompt, signal?: AbortSignal): Promise<PromptResponse | null>
}

/** A prompter for when nobody is there to answer, e.g. an automatic reconnect. */
export const silentPrompter: Prompter = { ask: async () => null }

interface Pending {
  kind: PromptRequest['kind']
  resolve(response: PromptResponse | null): void
}

/**
 * Bridges prompts to the renderer: `ask` sends a request and waits for `respond`.
 * `send` returns false when there is no window to show it in.
 */
export class PromptBroker implements Prompter {
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly send: (request: PromptRequest) => boolean,
    private readonly sendCancel: (id: string) => void
  ) {}

  ask(prompt: NewPrompt, signal?: AbortSignal): Promise<PromptResponse | null> {
    if (signal?.aborted) return Promise.resolve(null)
    const id = randomUUID()
    return new Promise((resolve) => {
      const finish = (response: PromptResponse | null): void => {
        if (!this.pending.delete(id)) return
        signal?.removeEventListener('abort', onAbort)
        resolve(response)
      }
      const onAbort = (): void => {
        if (this.pending.has(id)) this.sendCancel(id)
        finish(null)
      }
      this.pending.set(id, { kind: prompt.kind, resolve: finish })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (!this.send({ ...prompt, id } as PromptRequest)) finish(null)
    })
  }

  /** An answer from the renderer. Unknown ids and answers of the wrong kind count as a cancel. */
  respond(id: string, response: PromptResponse | null): void {
    const entry = this.pending.get(id)
    if (!entry) return
    const matches =
      response !== null &&
      (entry.kind === 'password' || entry.kind === 'passphrase'
        ? response.kind === 'password' || response.kind === 'passphrase'
          ? response.kind === entry.kind
          : false
        : response.kind === entry.kind)
    entry.resolve(matches ? response : null)
  }

  get size(): number {
    return this.pending.size
  }
}
