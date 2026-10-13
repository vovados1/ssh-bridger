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
