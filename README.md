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
