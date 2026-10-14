# SSH Bridger

Electron file manager that shows your local machine and any number of SSH/SFTP hosts as
side-by-side columns, with drag-and-drop transfers between them. See [PLAN.md](PLAN.md).

## Development

Requires Node >= 24 and [pnpm](https://pnpm.io) 11.

```sh
pnpm install
pnpm dev          # run the app with HMR
pnpm typecheck
pnpm lint
pnpm test
pnpm build        # typecheck + production build into ./out
```

If Electron's binary is missing after install, run `pnpm rebuild electron`
(build scripts are allow-listed in `pnpm-workspace.yaml`).

## SSH connections

Use **Connect** in the toolbar to add a host, import hosts from `~/.ssh/config`, or open a saved one.
Each connection opens as another column with the same file operations as the local one.

- **Host keys** are checked against `~/.ssh/known_hosts` (hashed entries included). An unknown host asks
  you to trust its SHA256 fingerprint; a **changed key is refused** with no way to click through.
- **Authentication** tries your SSH agent, key files (asking for a passphrase when needed), password and
  keyboard-interactive prompts (2FA), in that order. Passwords and passphrases are only remembered in the
  system keyring, and only if you ask; without a keyring nothing is stored.
- **Jump hosts** (ProxyJump) are supported; imports pick them up from your config.
- Dropped connections reconnect automatically with backoff, without prompting.
- Remote machines have no Trash: Delete asks first and is permanent. SFTP can't report changes, so open
  remote folders are re-read every few seconds instead (see Settings); F5 refreshes right away.

Integration tests start a real `sshd` as your user (needs `/usr/bin/sshd` and `sftp-server`); they skip
themselves if OpenSSH's server isn't installed.

## Columns and transfers

- **Columns:** add a local column from the Connect menu, drag a header to reorder, drag a divider (or
  focus it and use the arrow keys) to resize. Columns, widths and folders are restored on the next
  launch; remote columns come back disconnected until you press Reconnect.
- **Drag and drop** items between columns, or drop files from your desktop onto one. Within a machine a
  drop moves; between machines it copies. Hold **Ctrl** to force a copy, **Shift** to force a move.
  Ctrl+C / Ctrl+X / Ctrl+V work across columns too.
- **Safe copies:** each file is written to a `.sshbridger-part` name, size-checked, given its
  permissions and times, then renamed into place, so an interrupted copy never leaves a half-written
  file under the real name. A move across machines deletes each source file only after its copy is
  verified. When a name is taken you choose Overwrite, Skip, Keep both or Overwrite if newer, for one
  file or for all of them.
- **The transfer panel** at the bottom shows progress, speed and time left; you can cancel a job,
  and retry one that had errors (it skips what already arrived).

## Settings

Open **Settings** in the toolbar (or press **Ctrl+,**). Changes apply right away.

- **Theme:** follow the system, light or dark.
- **Transfers:** files copied at once per transfer and in total, how many transfers run at once, and
  whether copies keep permissions and modification times.
- **SSH folders:** how often open remote folders are re-read (0 turns it off).

Settings live in `settings.json` in the app's data folder (`~/.config/ssh-bridger/`). A bad value falls
back to its default, and a file that isn't valid JSON is moved aside as `settings.json.corrupt-…`.

## Building packages

```sh
pnpm package       # AppImage, .deb and pacman package in ./release
pnpm package:dir   # just the unpacked app in ./release/linux-unpacked, for a quick check
```

The `.deb` and pacman targets are built with `fpm`, whose bundled Ruby needs `libcrypt.so.1`. On Arch
that comes from `libxcrypt-compat` (`sudo pacman -S libxcrypt-compat`); Debian and Ubuntu have it already.
Set the real maintainer e-mail in `electron-builder.yml` and `package.json` before publishing.

Large-transfer stress test (the default size is small so the normal suite stays quick):

```sh
BRIDGER_STRESS_MB=2600 pnpm exec vitest run test/integration/transfer-stress.test.ts
```

## Keyboard shortcuts

| Key                           | Action                                 |
| ----------------------------- | -------------------------------------- |
| Arrows, PageUp/Down, Home/End | Move the cursor (hold Shift to extend) |
| Enter / Backspace             | Open folder / go up                    |
| Alt+← / Alt+→                 | History back / forward                 |
| Ctrl+L                        | Type a path                            |
| F5                            | Refresh                                |
| Ctrl+,                        | Settings                               |
| Ctrl+H                        | Show or hide hidden files              |
| Ctrl+A / Esc                  | Select all / clear selection           |
| F2                            | Rename                                 |
| Delete / Shift+Delete         | Move to Trash / delete permanently     |
| Ctrl+Shift+N / Ctrl+Alt+N     | New folder / new file                  |
| Alt+Enter                     | Properties                             |
| Shift+F10 or Menu key         | Context menu                           |
