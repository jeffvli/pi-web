# Desktop shell design

Why this shape, and where the boundaries are.

## The app is a server, so the shell is a client

Pi Web is a Node server: the pi SDK runs AgentSessions in-process, `node-pty`
backs the terminal, events stream over SSE, and uploads go through API routes.
There is no static export to load from disk. The desktop app therefore runs the
real server and shows it in a window, which means:

- The window's document origin is `http://127.0.0.1:<port>`. Every request is
  ordinary same-origin browser traffic, so `lib/request-security.ts` (Host and
  Origin checks), `proxy.ts`, cookies, SSE, uploads and downloads all behave as
  they do in a browser tab. Nothing in upstream had to learn about a desktop
  shell, and no `tauri://`-style origin needed to be added to an allow-list.
- A server crash is a window with a dialog, not a dead app: the process
  boundary in `server-process.js` keeps the two apart.

## Electron, not Tauri

Chosen on the facts of this app, not on framework preference:

| | Electron | Tauri |
| --- | --- | --- |
| Server runtime | main process **is** Node: `ELECTRON_RUN_AS_NODE=1` makes the app binary act as `node`, so upstream's `bin/pi-web.js` runs unmodified | must ship a ~85 MB Node runtime as a resource and spawn it |
| Payload | Chromium + Node ≈ 200 MB dist | Node + app, shell ≈ 10 MB; the app dominates, so installers land in the same range |
| `node-pty` | N-API (`node-addon-api`, ships `prebuilds/<os>-<arch>`) → no rebuild for Electron | same prebuilds work for the bundled Node |
| Linux | ships its own Chromium: identical on every distro | needs `webkit2gtk-4.1`; AppImage/linuxdeploy quirks; WebKitGTK varies by distro |
| Unsigned builds | fine to install and run; auto-update is the part that needs signing | minisign updater works unsigned |

The deciding line is the first one: Electron removes the second runtime
entirely, and the payload is dominated by the app either way, so Tauri's size
advantage does not exist here. Electron's Node is 24.22.2 (Electron 45.3.1),
above pi-web's `>=22.19.0` gate checked in `bin/node-version.js`.

The cost is accepted knowingly: the auto-updater needs signed installers, so it
is not shipped; the main process is full-privilege Node, so the renderer gets no
Node at all (see Security).

## The payload is the npm package

`scripts/prepare-app.mjs` stages `bin`, `.next`, `public`, `next.config.ts`,
`package.json` — the package's own `files` list — then runs
`npm ci --omit=dev` inside it. Pruning devDependencies is safe for the same
reason the published package works: webpack bundles the server-side routes and
components, so a devDependency imported by a server route (e.g. `mammoth` in
`app/api/files/[...path]/route.ts`) ends up inside `.next/server`. Only packages
in `next.config.ts`'s `serverExternalPackages` are read from `node_modules` at
runtime — `node-pty`, `undici`, `web-push` and the `@earendil-works/*` set — and
all of those are production dependencies.

`scripts/verify-packaged.mjs` proves the claim in CI: it starts the packaged
server with the packaged binary acting as node, and requires `GET /` and
`GET /api/sessions` to answer. A payload that pruned something the server needs
fails there, not on a user's machine.

The shell's own sources go in an asar; the app payload stays outside it, because
next's server reads its own files with plain fs and spawns scripts from `bin/`.

## Versioning follows upstream

`package.json` is the version: a `v0.16.0` tag yields a desktop app of 0.16.0,
and the workflow's tag check mirrors `publish.yml`'s `check-tag` job.
`desktop/package.json` carries the same number (checked by `sync-version.mjs
--check`) because electron-builder reads the version from the package it builds.
No desktop-only version line, no `-desktop` suffix: the release is the app.

## Security model

- The renderer is remote content: `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, and **no preload**. The UI never gets Node, so
  anything the shell can do lives in the small, auditable main process.
- Permissions are granted per origin and only for what the app uses:
  `notifications` (agent completion) and `clipboard-sanitized-write` (copy
  buttons). `will-attach-webview` is blocked; popups and navigations leave the
  app origin only through `shell.openExternal` for http/https/mailto.
- Popups on the app origin (the session export) open as in-app windows;
  external popups (OAuth sign-in pages) open in the default browser, which is
  where those flows expect a browser anyway.
- The server binds 127.0.0.1 with no password — the same exposure as running
  `pi-web` on the CLI. That is a real, accepted property: any process on the
  machine can drive an agent that runs shell commands. A desktop-only hardening
  path exists without touching upstream: generate a password, and mint the
  `pi_web_session` cookie the proxy accepts (`v1.<exp>.<nonce>` signed
  `HMAC-SHA256(password, "pi-web-session:" + payload)`, `lib/web-auth.ts`) and
  set it in the persistent partition.

## What the shell owns

Things a browser tab cannot do, and the only reasons the shell exists:

- pick a free loopback port and start the server on it
- keep a persistent partition (a login cookie, sidebar choices)
- menus, zoom, downloads to the Downloads folder (with a save prompt option),
  notification permission, window title from the page
- the server log, the crash dialog, restart-on-demand, single-instance focus
- `PI_WEB_NO_OPEN=1` (the shell owns the window) and
  `PI_WEB_SKIP_VERSION_CHECK=1` (an npm self-update check makes no sense inside
  a bundle the user cannot `npm update`)

## Non-goals

Auto-update (blocked on signing, feed already published), tray icon, deep links,
`pi-web` CLI subcommands in the shell, per-user file-root settings, shell
localisation, and any change to the web app's behaviour. Windows-only
graceful-shutdown fidelity is out of scope too: there is no signal to forward,
so quitting force-kills the tree.

## Merging upstream

`desktop/` and `.github/workflows/desktop-release.yml` are the only desktop
files, and no upstream file references them. Upstream `main` merges cleanly; the
files that would need attention are `desktop/server-process.js` (if the
launcher's CLI changes: today a bare invocation is the server, with `-p` and
`--no-open`), `desktop/scripts/prepare-app.mjs` (if the package's `files` list
changes) and `desktop/electron-builder.yml` (if `serverExternalPackages` grows —
a package there that is only a devDependency would ship broken, and
`verify-packaged.mjs` is the guard).
