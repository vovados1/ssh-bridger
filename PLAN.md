# SSH Bridger — Project Plan

A Linux desktop file manager (Electron) that shows the local machine and any number of
SSH/SFTP-connected machines as side-by-side columns, with drag-and-drop transfers between
any two of them.

## 1. Scope

### v1 (in scope)

- **Local column**, always present, rooted at `$HOME` by default.
- **SSH connections**: saved profiles, opened as additional columns (SSH transport + SFTP subsystem).
- **Browse** any column: navigate, breadcrumb/path bar, back/forward/up, sort, show/hide dotfiles, follow symlinks.
- **File operations** on any machine: create folder, create empty file, rename, delete, chmod, properties.
- **Transfers**: drag-and-drop (and copy/cut/paste) of files and folders between any two columns —
  local↔remote and remote↔remote. Recursive, queued, with progress, cancel, and conflict resolution.
- **Drag in from the OS** file manager onto any column.

### Explicit non-goals for v1

- Editing file contents (no built-in editor, no "open externally and re-upload"). v1 "edit" = rename / chmod / move.
- Windows and macOS. Linux only, so paths are POSIX everywhere and the agent is `SSH_AUTH_SOCK`.
- Dragging remote files _out_ to the OS file manager (needs a download-first step, see §9).
- Terminal, port forwarding, file preview, search, sync.

## 2. Tech stack

| Concern         | Choice                                                   | Why                                                                                                                         |
| --------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Shell           | Electron (current stable)                                | Requirement                                                                                                                 |
| Build           | `electron-vite`                                          | One config for main, preload, and renderer. Fast HMR                                                                        |
| Language        | TypeScript, `strict`                                     | Shared types across the IPC boundary                                                                                        |
| UI              | React 19                                                 | —                                                                                                                           |
| State           | Zustand                                                  | Small, works well with per-column stores                                                                                    |
| Big lists       | `@tanstack/react-virtual`                                | Directories with 10k+ entries                                                                                               |
| Column layout   | `react-resizable-panels`                                 | Resizable side-by-side columns                                                                                              |
| Styling         | CSS Modules + CSS variables (light/dark)                 | No runtime cost. Easy to theme                                                                                              |
| SSH/SFTP        | `ssh2`                                                   | Pure JS, mature, supports agent/keys/password/keyboard-interactive, multiple SFTP channels, and jump hosts via `forwardOut` |
| SSH config      | `ssh-config`                                             | Parse `~/.ssh/config` for host aliases                                                                                      |
| Local watch     | `fs.watch` (non-recursive inotify)                       | We only watch the folders on screen. A recursive watcher over `$HOME` would burn inotify watches for no benefit             |
| Secrets         | Electron `safeStorage`                                   | Backed by libsecret/KWallet on Linux                                                                                        |
| Tests           | Vitest (unit/integration), Playwright for Electron (e2e) | —                                                                                                                           |
| Packaging       | `electron-builder` → AppImage, `.deb`, `pacman`          | Covers the main distros, including Arch                                                                                     |
| Package manager | pnpm                                                     | Fast, strict dependency tree, disk-efficient. Pinned via `packageManager` in package.json                                   |

## 3. Architecture

```
┌──────────────────────── Renderer (React, sandboxed) ─────────────────────────┐
│  Columns[]  ─ each bound to a machineId + cwd                                │
│  TransferPanel   ConnectionManager UI   Dialogs (conflict, host key, auth)   │
└──────────────▲──────────────────────────────────────────────┬────────────────┘
               │ events (progress, fs changes, conn state)    │ invoke (typed)
┌──────────────┴──────── Preload (contextBridge, typed API) ──▼────────────────┐
└──────────────▲──────────────────────────────────────────────┬────────────────┘
┌──────────────┴──────────────── Main process ────────────────▼────────────────┐
│  IPC router (zod-validated)                                                  │
│  MachineRegistry ── machineId → FileSystemProvider                           │
│     ├─ LocalProvider   (node:fs/promises, fs.watch, shell.trashItem)  │
│     └─ SftpProvider    (ssh2 Client → SFTP channels)                         │
│  ConnectionManager  (profiles, auth, known_hosts, keepalive, reconnect)      │
│  TransferManager    (queue, workers, progress, conflicts, cancel)            │
│  SecretStore        (safeStorage)    ProfileStore / SettingsStore (JSON)     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Principles**

- **All I/O lives in main.** The renderer has no Node access (`contextIsolation: true`,
  `sandbox: true`, `nodeIntegration: false`). It only sees the typed preload API.
- **One interface, two backends.** UI and TransferManager talk only to `FileSystemProvider`,
  so local and remote behave the same way.
- **Validate at the boundary.** Every IPC payload is checked with zod in main, because the renderer is untrusted.
- **One SSH connection per profile.** Multiple columns on the same host share it. Browsing and
  transfers use **separate SFTP channels**, so listing a directory stays fast during a big upload.

### 3.1 FileSystemProvider

```ts
type MachineId = 'local' | `ssh:${string}`

interface Entry {
  name: string
  path: string // absolute POSIX path
  type: 'file' | 'dir' | 'symlink' | 'other'
  size: number
  mtime: number // ms epoch
  mode: number // permission bits
  owner?: string
  group?: string // resolved names when available
  linkTarget?: string
  linkTargetType?: 'file' | 'dir' | 'broken'
}

interface FileSystemProvider {
  readonly id: MachineId
  home(): Promise<string>
  realpath(path: string): Promise<string>
  list(dir: string): Promise<Entry[]>
  stat(path: string): Promise<Entry>
  mkdir(path: string): Promise<void>
  createFile(path: string): Promise<void> // fails if exists
  rename(from: string, to: string): Promise<void> // same-machine move
  remove(path: string, opts: { recursive: boolean; toTrash?: boolean }): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  setTimes(path: string, mtime: number): Promise<void>
  createReadStream(path: string, opts?: { start?: number }): Readable
  createWriteStream(path: string, opts?: { mode?: number }): Writable
  watch?(dir: string, onChange: () => void): () => void // local only
}
```

Errors are normalized to `FsError { code: 'ENOENT' | 'EACCES' | 'EEXIST' | 'ENOTEMPTY' |
'EDISCONNECTED' | 'EUNKNOWN'; path; message }`. SFTP status codes map onto the same set, so
the UI shows one kind of error regardless of machine.

**SFTP specifics**

- No recursive delete in SFTP: walk depth-first and `unlink`/`rmdir` each entry.
  Remote delete is permanent, so the confirm dialog says so.
- No change notifications: refresh after our own operations, on focus, on F5, and optionally
  poll the visible directory every N seconds (setting, off by default).
- Owner and group names come back as numeric uid/gid in SFTP v3. Show the numbers, or use
  `longname` when the server provides it.

### 3.2 ConnectionManager

- **Profiles** (`profiles.json` in `app.getPath('userData')`): name, host, port, user, auth
  method, identity file, jump host, default remote path, color tag.
- **Import from `~/.ssh/config`**: list `Host` aliases. Resolve `HostName`, `User`, `Port`,
  `IdentityFile`, `ProxyJump`. Imported profiles stay linked to the alias and are re-resolved
  at every connect.
- **Auth order** (configurable per profile): agent (`SSH_AUTH_SOCK`), then key file (prompt for
  passphrase if encrypted), then password, then keyboard-interactive (2FA prompts are relayed to
  a renderer dialog).
- **Host key verification**: read `~/.ssh/known_hosts`, including hashed `|1|` entries
  (HMAC-SHA1). Unknown host: show the fingerprint (SHA256) for trust-on-first-use, then optionally append to
  known_hosts. **Mismatch: hard fail with a clear warning. Never offer one-click accept.**
- **Secrets**: passwords and passphrases are saved only on opt-in, via `safeStorage`. If
  `safeStorage.getSelectedStorageBackend()` returns `basic_text` (no keyring), refuse to save
  and explain why.
- **Lifecycle**: states are `connecting → connected → reconnecting → disconnected/error`. Keepalive
  every 15s. On an unexpected drop, reconnect with backoff and restore open columns at their last cwd.
- **Jump hosts**: connect to the jump host, `forwardOut` to the target, and pass the stream as `sock`.

### 3.3 TransferManager

- A **job** is a user action (a drop or paste). It expands into **tasks** (one per file, plus
  directory creates) via a recursive walk of the source.
- **Execution paths**:
  - local → remote: `sftp.fastPut` (parallel requests, much faster than streaming)
  - remote → local: `sftp.fastGet`
  - remote → remote, or same remote across two profiles: pipe `createReadStream` from A into
    `createWriteStream` on B, through the app
  - same machine: `rename` for move. Copy uses `fs.cp` locally, or a stream remotely
- **Safe writes**: write to `name.sshbridger-part`, then rename over the target. Preserve mode
  and mtime (setting, on by default).
- **Move across machines** = copy, verify the size matches, then delete the source. If any task
  fails, the source is kept.
- **Concurrency**: N parallel tasks per job (default 3). A global limit stops the app from
  saturating a single connection.
- **Conflicts**: pause and ask Overwrite / Skip / Keep both (rename) / Overwrite if newer, with
  "apply to all". The answer is scoped to the job.
- **Progress**: bytes/sec, ETA, and per-file plus total progress, sent to the renderer at most
  every 100ms. Cancel stops the job, aborts streams, and removes `.part` files.
- **Panel**: a collapsible bottom bar with active, queued, and finished jobs. Errors can be retried.

## 4. UI / UX

```
┌───────────────────────────────────────────────────────────────────────────┐
│ [+ Connect ▾]                                         [⚙]                 │
├─ 💻 Local ──────────┬─ 🌐 prod-1 ● ─────────┬─ 🌐 nas ● ──────────── [×] ─┤
│ ‹ › ↑  ~/projects   │ ‹ › ↑  /var/www       │ ‹ › ↑  /mnt/media           │
│ Name     Size  Mod  │ Name      Size  Mod   │ Name      Size  Mod         │
│ 📁 src              │ 📁 html               │ 📁 movies                   │
│ 📄 a.txt  2K  ...   │ 📄 index.php  ...     │ 📁 music                    │
├─────────────────────┴───────────────────────┴─────────────────────────────┤
│ ⇅ Transfers: 2 active · 34 MB/s · a.txt → prod-1:/var/www   ▓▓▓▓▓░░ 71%   │
└───────────────────────────────────────────────────────────────────────────┘
```

- **Columns**: resizable side-by-side panels with horizontal scroll when there are many.
  You can open several columns on the same machine (for example two local columns).
  Column order and widths are saved.
- **Column header**: machine name, color tag, connection status dot, and close button. A path bar
  that turns into an editable text input on click, and back/forward/up.
- **List**: virtualized rows. Name, size, modified, and permissions columns, all sortable.
  Folders sort first. Hidden-files toggle per column.
- **Selection**: click, Ctrl-click, Shift-click, Ctrl+A, rubber-band selection (later), and keyboard navigation.
- **Drag and drop**:
  - Internal drags carry `application/x-sshbridger` with `{ machineId, paths[] }`.
  - Drop on a folder row puts items in that folder. Drop on empty space puts them in the column's cwd.
  - Same machine defaults to move. Different machine defaults to copy. Ctrl forces copy, Shift forces move.
  - OS drag-in: read paths with `webUtils.getPathForFile(file)` (`File.path` has been removed in
    current Electron) and treat them as coming from `local`.
- **Context menu**: New Folder, New File, Rename (F2), Delete (Del), Permissions…, Copy Path,
  Refresh, Properties.
- **Shortcuts**: Ctrl+C/X/V across columns, Enter to open, Backspace for up, Alt+←/→ for history,
  F5 to refresh, Ctrl+H for hidden files, Ctrl+L to focus the path bar, Tab to switch column.
- **Local delete** goes to the Trash by default (`shell.trashItem`). Shift+Del deletes permanently.

## 5. Project structure

```
ssh-bridger/
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ src/
│  ├─ shared/                 # types used by every process
│  │  ├─ ipc.ts               # channel names + request/response/event types + zod schemas
│  │  ├─ fs-types.ts          # Entry, FsError, MachineId
│  │  └─ transfer-types.ts
│  ├─ main/
│  │  ├─ index.ts             # app lifecycle, BrowserWindow (secure defaults)
│  │  ├─ ipc/                 # handlers, one file per domain
│  │  ├─ fs/
│  │  │  ├─ provider.ts
│  │  │  ├─ local-provider.ts
│  │  │  ├─ sftp-provider.ts
│  │  │  └─ errors.ts
│  │  ├─ ssh/
│  │  │  ├─ connection-manager.ts
│  │  │  ├─ known-hosts.ts
│  │  │  ├─ ssh-config-import.ts
│  │  │  └─ auth.ts
│  │  ├─ transfer/
│  │  │  ├─ transfer-manager.ts
│  │  │  ├─ planner.ts        # recursive walk → tasks
│  │  │  └─ executors.ts      # fastPut/fastGet/stream/rename/cp
│  │  └─ store/               # profiles, settings, secrets
│  ├─ preload/
│  │  └─ index.ts             # contextBridge.exposeInMainWorld('api', …)
│  └─ renderer/
│     ├─ main.tsx
│     ├─ app/                 # layout, ColumnsArea, TransferPanel
│     ├─ features/
│     │  ├─ column/           # Column, PathBar, FileList, useColumnStore
│     │  ├─ connections/      # ConnectDialog, ProfileEditor, HostKeyDialog, AuthPrompt
│     │  ├─ transfers/
│     │  └─ dnd/
│     └─ lib/api.ts           # typed wrapper over window.api
├─ test/
│  ├─ integration/            # providers + transfers against a real sshd
│  └─ e2e/                    # Playwright _electron
└─ docker/sftp-test/          # throwaway OpenSSH server for tests
```

## 6. Milestones

Each milestone ends with something runnable.

**M0: Scaffold**

- electron-vite React+TS template, ESLint, Prettier, Vitest, secure `BrowserWindow` defaults, CSP.
- A typed IPC skeleton with one round-trip (`fs.home`) and zod validation.
- CI: typecheck, lint, unit tests.

**M1: Local browsing (one column)**

- `FileSystemProvider` + `LocalProvider` (`list`, `stat`, `realpath`, `home`).
- Column UI: path bar, history, virtualized sortable list, hidden toggle, symlinks, keyboard navigation.
- Done when a 50k-entry directory scrolls smoothly.

**M2: Local file operations**

- mkdir, createFile, rename (inline), delete-to-trash, chmod dialog, properties.
- Context menu and shortcuts. Watcher-driven auto-refresh. Normalized error toasts.

**M3: SSH connections**

- Profile store, connect dialog, `~/.ssh/config` import.
- Auth: agent, key with passphrase, password, keyboard-interactive. known_hosts verification and TOFU dialog.
- `SftpProvider` with the same operations as local (recursive delete via walk).
- Shared connection per profile, status dot, keepalive, reconnect.
- Test fixture: a real OpenSSH `sshd` started per test file as the current user on a random port (no Docker needed), plus an in-process ssh2 server for password and keyboard-interactive flows. The provider contract suite runs against **both** providers.

**M4: Multi-column + transfers**

- Add/close/reorder/resize columns. Persist layout and last cwd.
- Internal DnD plus copy/cut/paste.
- TransferManager: planner, executors, `.part` + rename, conflicts, cancel, concurrency, progress panel.
- Remote↔remote via piped streams. Cross-machine move = copy + verify + delete.

**M5: Polish + ship**

- OS drag-in, settings page (concurrency, preserve times, polling, theme), dark mode.
- Error/empty/loading states, and a large-transfer stress test.
- electron-builder packaging (AppImage, deb, pacman), app icon, versioning.

## 7. Testing strategy

- **Provider contract tests**: one Vitest suite parameterized over `LocalProvider` (tmp dir) and
  `SftpProvider` (a real `sshd` started by the tests). Any behavior difference is a bug.
- **Transfer tests**: every source/target pair (L→R, R→L, R→R, L→L), with nested dirs, empty dirs,
  symlinks, 0-byte and >1 GB files, cancel mid-file (no `.part` left behind), each conflict policy, and move rollback on failure.
- **SSH tests**: unknown host, changed host key (must refuse), encrypted key, wrong password,
  keyboard-interactive, jump host (a second `sshd`), connection drop during a transfer.
- **E2E (Playwright `_electron`)**: open the app, connect to the fixture, drag a file from local to
  remote, assert it arrives.

## 8. Security checklist

- Renderer: `contextIsolation`, `sandbox`, no `nodeIntegration`, a strict CSP, no remote content
  loaded, and `setWindowOpenHandler` denies everything.
- IPC: allowlisted channels, zod validation, and machineIds that must reference a live connection.
- Never auto-accept changed host keys.
- Secrets only through `safeStorage`, and never logged. Log redaction for passwords and passphrases.
- `.part` files are created with mode `0600` until the final chmod.

## 9. Risks & open questions

| Risk                                                          | Mitigation                                                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Remote→remote throughput is limited by the client's bandwidth | Acceptable for v1. Later: optional direct server-to-server copy (`scp`/`rsync` via exec on A, when A can reach B) |
| SFTP streaming is slow on high-latency links                  | Use `fastGet`/`fastPut` where possible. Tune stream `highWaterMark` and concurrency                               |
| Huge remote directories are slow to `readdir`                 | Stream entries into the list progressively and show a spinner. Cancel stale listings when the user navigates away |
| No keyring on minimal Linux setups                            | Detect the `basic_text` backend and disable password saving. The agent and keys still work                        |
| Hashed known_hosts and `@cert-authority` / `@revoked` markers | Support hashed entries in v1. Treat `@revoked` as a hard fail. CA certificates are deferred                       |
| Dragging remote files out to the OS                           | Post-v1: download to a temp dir, then `webContents.startDrag`                                                     |

## 10. Post-v1 ideas

Content editing (built-in CodeMirror, or open externally with auto re-upload), file preview,
bookmarks/favorites per machine, search, an embedded terminal per connection, folder sync/compare,
macOS/Windows builds, port forwarding.
