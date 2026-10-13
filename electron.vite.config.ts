import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

const shared = resolve('src/shared')

// Strict CSP in production. Dev needs inline scripts (React refresh preamble) and a
// websocket for HMR, so the policy is relaxed only while `electron-vite dev` runs.
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self' ws://localhost:*; object-src 'none'; base-uri 'none'"

function csp(): Plugin {
  let dev = false
  return {
    name: 'ssh-bridger:csp',
    configResolved(config) {
      dev = config.command === 'serve'
    },
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replace('__CSP__', dev ? DEV_CSP : PROD_CSP)
    }
  }
}

export default defineConfig({
  main: { resolve: { alias: { '@shared': shared } } },
  preload: { resolve: { alias: { '@shared': shared } } },
  renderer: {
    resolve: { alias: { '@shared': shared, '@': resolve('src/renderer/src') } },
    build: { minify: 'esbuild' },
    plugins: [react(), csp()]
  }
})
