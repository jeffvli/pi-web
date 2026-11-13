# Pi Web — desktop app

An Electron window around the Pi Web server. The web app is unchanged: this
folder adds a shell that builds the app, runs it as a child process on a
loopback port, and points a window at it. Merging upstream touches nothing here,
and nothing here touches upstream.

```
desktop/
  main.js               window, menus, popups, downloads, permissions, shutdown
  server-process.js     spawns and supervises the Pi Web server
  electron-builder.yml  packaging: NSIS + MSI, dmg + zip, AppImage + deb
  scripts/
    prepare-app.mjs     stages the payload (npm-package shape + prod deps)
    after-pack.cjs      copies the staged payload into the app (see Packaging)
    sync-version.mjs    keeps the shell version equal to package.json
    verify-packaged.mjs starts the packaged server headless and checks it
    smoke.mjs           opens a window on a running server, screenshots it
    ci-local.mjs        runs the release chain in a throwaway worktree
  test/shell.test.mjs   the shell's pure logic, run by `npm test`
```

## Run it against a dev server

The fastest loop: the shell attaches to an already-running Pi Web and never
starts its own server.

```bash
npm run dev                      # repo root, port 30141
npm --prefix desktop ci --include=dev
npm --prefix desktop run dev     # window on http://127.0.0.1:30141
```

`--include=dev` matters when the environment sets `NODE_ENV=production`: npm
then omits devDependencies and Electron is never downloaded.

## Build the desktop app locally

```bash
npm run build                    # production build (never while a dev server runs)
npm --prefix desktop run prepare-app   # stages desktop/app-staging
npm --prefix desktop run pack          # unpacked app in desktop/dist
desktop/dist/win-unpacked/pi-web-desktop.exe
```

`prepare-app` runs `npm ci --omit=dev` inside the staged folder, so the payload
is the published npm package shape plus production dependencies — what a CLI
user gets from `npm install -g @agegr/pi-web`.

## Packaging

Measured on the v0.16.0 payload: 522 MB staged (28 086 files), 357 MB of
Electron, 879 MB unpacked, and a compressed installer in the 250–300 MB range.
The app, not the shell, is the size, which is the whole reason Electron was
chosen over Tauri: the server needs a Node runtime, and Electron's main process
*is* one.

Two things about it are deliberate:

- `scripts/after-pack.cjs` copies the staged tree to `resources/app`. It cannot
  be declared in `files` or `extraResources`: electron-builder strips
  `**/node_modules/**` from every user file set, and the packaged server then
  starts and dies on `Cannot find module 'next'`. That failure was hit and is
  the reason the hook exists.
- The server is started as the app binary acting as node:
  `pi-web-desktop.exe bin/pi-web.js -p <free port> --no-open` with
  `ELECTRON_RUN_AS_NODE=1`. A bare `pi-web` invocation *is* the server; there is
  no `start` subcommand.

## Tests

```bash
npm --prefix desktop test      # the shell's pure logic
npm --prefix desktop run smoke # a real window against a running server
npm --prefix desktop run ci:local -- --dir --keep   # the release chain locally
```

`ci:local` builds in a throwaway worktree, and passes `--max-heap` to the build:
`next build` can exhaust V8's heap on a developer machine (4 GB, 6 GB and 12 GB
all aborted locally, while CI finishes in ~3 min). Nothing to do with the shell —
it is the app's webpack build. The worktree also keeps a production build away
from a running dev server's `.next`.

## Release

Run `.github/workflows/desktop-release.yml` from the Actions tab, or push the
`v*` tag that publishes npm and Docker:

```bash
git push origin main v0.16.0
```

The workflow is one matrix job and nothing else. Each platform — Windows x64,
macOS arm64, macOS x64, Linux — builds, stages its payload for the right
architecture, packages, verifies the packaged server over HTTP, and publishes
with `electron-builder --publish always`, which creates the **draft** release
named `v<package.json version>` when it is missing and uploads its installers
and `latest*.yml` update feeds to it:

| File | Platform |
| --- | --- |
| `pi-web-desktop-<version>-win-x64-setup.exe` | Windows installer (NSIS) |
| `pi-web-desktop-<version>-win-x64.msi` | Windows installer (MSI) |
| `pi-web-desktop-<version>-macos-arm64.dmg` | macOS Apple Silicon |
| `pi-web-desktop-<version>-macos-x64.dmg` | macOS Intel |
| `pi-web-desktop-<version>-linux-x86_64.AppImage` | Linux AppImage |
| `pi-web-desktop-<version>-linux_amd64.deb` | Linux deb |

The workflow never marks the release ready: you write the notes and publish it,
as [docs/release.md](../docs/release.md) describes. A run whose tag does not
exist makes GitHub create the tag at the dispatched commit, so a manual run is a
real dry run of the release path; a pushed `v*` tag — the tag that also publishes
npm and Docker — appends the desktop assets to that tag's release. A push to
`main` publishes nothing.

The draft is deliberate: an updater must not pick a build that is still
arriving, and the release is only trustworthy once you publish it.

## Signing

Builds are unsigned: Windows SmartScreen says "unknown publisher", and a macOS
download needs `xattr -d com.apple.quarantine` on the `.app` (an unsigned
Apple Silicon binary will not start at all). To ship signed builds, set
`CSC_LINK`/`CSC_KEY_PASSWORD` and Apple notarization credentials as repo secrets,
set `CSC_IDENTITY_AUTO_DISCOVERY: true`, and drop `notarize: false`,
`gatekeeperAssess: false` and `hardenedRuntime: false` from
`desktop/electron-builder.yml`. Windows code signing needs `win.certificateFile`
/ `win.certificatePassword` (or `win.sign`). The GitHub publish config is already
in place, so `latest*.yml` update feeds ship today and an auto-updater needs
only signing.

## Where to look when something is wrong

- Server log: Help → Open server log (`userData/logs/pi-web-server.log`).
- Server address: Help → Copy server address, then open it in a browser: the UI
  is the same server a CLI run serves, so a browser is a valid second opinion.
- Shell data: Help → Open app data folder (window settings, a login cookie).
- The webview's own DevTools: View → Toggle DevTools.

## Limits

- The server has no password by default, exactly like `pi-web` on the CLI: any
  local process can drive it. See [DESIGN.md](./DESIGN.md) for the model.
- No auto-updater yet: it needs signed installers, and the update feeds in a
  draft release are not readable by an updater until you publish the release.
- Menus are English; the web UI keeps its own language setting.
- On Windows, quitting force-kills the server tree (no signal to forward).
- On Linux the Chromium sandbox uses unprivileged user namespaces, which current
  distros enable; a distro without them needs `--no-sandbox` at launch.
  electron-builder 26 has no `chromeSandbox` option, so this is a launch flag,
  not a build flag.
