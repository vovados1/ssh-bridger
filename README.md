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
- Remote machines have no Trash: Delete asks first and is permanent. Remote folders don't update by
  themselves (SFTP can't report changes), so use F5.

Integration tests start a real `sshd` as your user (needs `/usr/bin/sshd` and `sftp-server`); they skip
themselves if OpenSSH's server isn't installed.

## Keyboard shortcuts

| Key                           | Action                                 |
| ----------------------------- | -------------------------------------- |
| Arrows, PageUp/Down, Home/End | Move the cursor (hold Shift to extend) |
| Enter / Backspace             | Open folder / go up                    |
| Alt+← / Alt+→                 | History back / forward                 |
| Ctrl+L                        | Type a path                            |
| F5                            | Refresh                                |
| Ctrl+H                        | Show or hide hidden files              |
| Ctrl+A / Esc                  | Select all / clear selection           |
| F2                            | Rename                                 |
| Delete / Shift+Delete         | Move to Trash / delete permanently     |
| Ctrl+Shift+N / Ctrl+Alt+N     | New folder / new file                  |
| Alt+Enter                     | Properties                             |
| Shift+F10 or Menu key         | Context menu                           |
