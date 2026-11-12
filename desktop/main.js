"use strict";

// Pi Web desktop shell.
//
// The window loads the loopback address Pi Web serves, exactly like a browser
// tab does: same origin, same Host and Origin headers, so the server's request
// security, SSE streams, uploads, downloads and popups all behave as they do on
// the web. The shell adds what a browser cannot: a bundled server process, a
// window, menus, downloads, notifications and a clean shutdown.

const { app, BrowserWindow, clipboard, dialog, Menu, nativeTheme, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { PiWebServer, findFreePort, waitForServer } = require("./server-process");

const REPO_URL = "https://github.com/jeffvli/pi-web";
const APP_NAME = "Pi Web";
const APP_USER_MODEL_ID = "com.github.jeffvli.piweb";
const PARTITION = "persist:pi-web";
const DEV_SERVER_URL = "http://127.0.0.1:30141";

const state = {
  server: null,
  window: null,
  origin: null,       // "http://127.0.0.1:34567" of the UI this shell shows
  attachUrl: null,    // set in --server-url mode: the shell owns no server
  appDir: null,
  quitting: false,
  settings: loadSettings(),
};

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = { serverUrl: process.env.PI_WEB_DESKTOP_SERVER_URL || null, appDir: process.env.PI_WEB_DESKTOP_APP_DIR || null };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--server-url" || arg === "--url") args.serverUrl = argv[++i] ?? args.serverUrl;
    else if (arg.startsWith("--server-url=")) args.serverUrl = arg.slice("--server-url=".length);
    else if (arg === "--app-dir") args.appDir = argv[++i] ?? args.appDir;
    else if (arg.startsWith("--app-dir=")) args.appDir = arg.slice("--app-dir=".length);
    else if (arg === "--dev") args.serverUrl = args.serverUrl ?? DEV_SERVER_URL;
  }
  return args;
}

// ---------------------------------------------------------------- settings

function settingsFile() {
  return path.join(app.getPath("userData"), "desktop-shell.json");
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return { saveDialogs: raw?.saveDialogs === true };
  } catch {
    return { saveDialogs: false };
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), `${JSON.stringify(state.settings, null, 2)}\n`);
  } catch {
    // A settings file the user cannot write is not worth a dialog.
  }
}

// ---------------------------------------------------------------- app paths

/**
 * Packaged: the payload lives in resources/app, copied in by
 * scripts/after-pack.cjs (macOS: inside Contents/Resources). Running from
 * source: the repository root, two levels up.
 */
function resolveAppDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, "app");
  return path.resolve(__dirname, "..");
}

function readShellVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function readPiWebVersion(appDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function serverLogFile() {
  return path.join(app.getPath("logs"), "pi-web-server.log");
}

// ---------------------------------------------------------------- splash

const SPLASH_URL =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>${APP_NAME}</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;gap:12px;flex-direction:column;
    font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#5e6673;background:#ffffff}
  @media (prefers-color-scheme:dark){body{background:#17181b;color:#9aa3ae}}
  .mark{font-size:22px;letter-spacing:.14em;color:#245bce;font-weight:600}
  .spin{width:22px;height:22px;border:2px solid rgba(128,128,128,.35);border-top-color:#245bce;
    border-radius:50%;animation:s 1s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
</style></head><body><div class="mark">PI WEB</div><div class="spin"></div><div>Starting the Pi Web server…</div></body></html>`);

// ---------------------------------------------------------------- window

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: dark ? "#17181b" : "#ffffff",
    title: APP_NAME,
    show: false,
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      // The UI is remote content served over loopback http: it gets no Node
      // access, no preload, and a persistent partition so pi's own state
      // (a login cookie, sidebar choices) survives restarts.
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (state.window === win) state.window = null;
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });

  // The app opens popups for two things: the session export (same origin) and
  // OAuth sign-in pages (external). Popups never get Node access.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) {
      createPopupWindow(url);
      return { action: "ignore" };
    }
    openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "normal" || state.quitting) return;
    dialog.showMessageBox(win, {
      type: "error",
      title: APP_NAME,
      message: "The window crashed.",
      detail: `Reason: ${details.reason}. Reload to continue.`,
      buttons: ["Reload", "Ignore"],
    }).then(({ response }) => {
      if (response === 0) win.webContents.reload();
    });
  });

  return win;
}

function createPopupWindow(url) {
  const parent = state.window;
  const popup = new BrowserWindow({
    parent: parent ?? undefined,
    width: 1100,
    height: 820,
    title: APP_NAME,
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  popup.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isAppUrl(target)) createPopupWindow(target);
    else openExternal(target);
    return { action: "deny" };
  });
  popup.webContents.on("will-navigate", (event, target) => {
    if (!isAppUrl(target)) {
      event.preventDefault();
      openExternal(target);
    }
  });
  popup.loadURL(url);
  return popup;
}

function isAppUrl(raw) {
  if (!state.origin) return false;
  try {
    return new URL(raw).origin === state.origin;
  } catch {
    return false;
  }
}

function openExternal(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
      void shell.openExternal(raw);
    }
  } catch {
    // Not a URL we can open.
  }
}

function showLoadFailure(win, error) {
  const detail = error instanceof Error ? error.message : String(error);
  const options = {
    type: "error",
    title: APP_NAME,
    message: "The Pi Web server is not answering.",
    detail: state.server
      ? `${detail}\n\nLast server output:\n${state.server.outputTail || "(none)"}`
      : detail,
    buttons: ["Try again", "Open log", "Quit"],
    defaultId: 0,
    cancelId: 2,
  };
  void dialog.showMessageBox(win, options).then(async ({ response }) => {
    if (response === 1) {
      await shell.openPath(serverLogFile());
      showLoadFailure(win, error);
      return;
    }
    if (response === 0) {
      const retry = state.attachUrl
        ? showServer(win, { attachUrl: state.attachUrl })
        : restartServer(win);
      void retry.catch((nextError) => showLoadFailure(win, nextError));
      return;
    }
    app.quit();
  });
}

// ---------------------------------------------------------------- permissions

function configurePermissions(ses) {
  // Only the UI origin gets the permissions Pi Web uses: completion
  // notifications, and clipboard writes for the copy buttons.
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const granting = permission === "notifications" || permission === "clipboard-sanitized-write";
    const origin = typeof details?.requestingOrigin === "string" ? details.requestingOrigin : "";
    callback(granting && isAppUrl(origin));
  });
  ses.setPermissionCheckHandler((_contents, permission, origin) => {
    const granting = permission === "notifications" || permission === "clipboard-sanitized-write";
    return granting && isAppUrl(origin || "");
  });

  // Downloads: save straight to the Downloads folder and reveal the file,
  // with the menu's "Ask where to save" for the prompt.
  ses.on("will-download", (_event, item) => {
    if (state.settings.saveDialogs) return;
    const target = path.join(app.getPath("downloads"), item.filename);
    item.setSavePath(target);
    item.once("done", (_e, doneState) => {
      if (doneState === "completed") void shell.showItemInFolder(target);
    });
  });
}

// ---------------------------------------------------------------- menu

function buildMenu() {
  const version = readShellVersion();
  const piWebVersion = readPiWebVersion(state.appDir ?? resolveAppDir());

  const template = [
    ...(process.platform === "darwin"
      ? [{
          role: "appMenu",
          submenu: [
            {
              label: `About ${APP_NAME}`,
              click: () => showAbout(),
            },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }]
      : []),
    {
      role: "editMenu",
      label: "Edit",
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        {
          label: "Ask where to save each time",
          type: "checkbox",
          checked: state.settings.saveDialogs,
          click: (item) => {
            state.settings.saveDialogs = item.checked;
            saveSettings();
          },
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      role: "windowMenu",
      label: "Window",
    },
    {
      role: "help",
      label: "Help",
      submenu: [
        {
          label: "Pi Web README",
          click: () => openExternal(`${REPO_URL}#readme`),
        },
        {
          label: "Releases",
          click: () => openExternal(`${REPO_URL}/releases`),
        },
        {
          label: "Report an issue",
          click: () => openExternal(`${REPO_URL}/issues`),
        },
        { type: "separator" },
        {
          label: "Copy server address",
          enabled: Boolean(state.origin),
          click: () => clipboard.writeText(state.origin ?? ""),
        },
        {
          label: "Open server log",
          click: () => void shell.openPath(serverLogFile()),
        },
        {
          label: "Open app data folder",
          click: () => void shell.openPath(app.getPath("userData")),
        },
        { type: "separator" },
        {
          label: `Pi Web ${piWebVersion} · shell ${version}`,
          enabled: false,
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAbout() {
  const piWebVersion = readPiWebVersion(state.appDir ?? resolveAppDir());
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: `Pi Web ${piWebVersion} (desktop shell ${readShellVersion()})`,
    copyright: "MIT · Pi Web",
  });
  app.showAboutPanel();
}

// ---------------------------------------------------------------- lifecycle

async function showServer(win, { attachUrl }) {
  if (attachUrl) {
    const target = new URL(attachUrl);
    state.origin = target.origin;
    state.attachUrl = attachUrl;
    await waitForServer(target.toString(), { timeoutMs: 30_000, label: attachUrl });
    await win.loadURL(attachUrl);
    return;
  }

  const server = state.server;
  if (!server) throw new Error("No server to show");
  state.origin = new URL(server.url).origin;
  await win.loadURL(server.url);
}

async function startOwnServer() {
  const port = await findFreePort();
  const server = new PiWebServer({
    appDir: state.appDir,
    logFile: serverLogFile(),
    port,
    extraEnv: { PI_WEB_DESKTOP_SHELL_VERSION: readShellVersion() },
  });
  state.server = server;
  await server.start();
  return server;
}

async function restartServer(win) {
  if (state.server) await state.server.stop();
  state.server = null;
  try {
    await win.loadURL(SPLASH_URL);
  } catch {
    // A splash that will not load is not fatal.
  }
  await startOwnServer();
  await showServer(win, { attachUrl: null });
}

function watchServerExit(win) {
  const server = state.server;
  if (!server) return;
  void server.exited.then((info) => {
    if (state.quitting || state.server !== server) return;
    const crashed = info.code !== 0 && info.code !== null;
    dialog.showMessageBox(win, {
      type: crashed ? "error" : "warning",
      title: APP_NAME,
      message: "The Pi Web server stopped.",
      detail: `Exit ${info.signal ? `signal ${info.signal}` : `code ${info.code}`}.`
        + (server.outputTail ? `\n\nLast server output:\n${server.outputTail}` : ""),
      buttons: ["Start again", "Quit"],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) void restartServer(win).catch((error) => showLoadFailure(win, error));
      else app.quit();
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);
  app.setName(APP_NAME);
  state.appDir = resolveAppDir();

  app.on("second-instance", () => {
    const win = state.window;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on("web-contents-created", (_event, contents) => {
    // New web contents must never leave the app origin, and never get Node.
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });

  configurePermissions(session.fromPartition(PARTITION));
  buildMenu();
  nativeTheme.on("updated", () => {
    const win = state.window;
    if (win && !win.isDestroyed()) {
      win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#17181b" : "#ffffff");
    }
  });

  const win = createWindow();
  state.window = win;
  await win.loadURL(SPLASH_URL);

  try {
    if (args.serverUrl) {
      await showServer(win, { attachUrl: args.serverUrl });
    } else {
      await startOwnServer();
      await showServer(win, { attachUrl: null });
    }
  } catch (error) {
    showLoadFailure(win, error);
    return;
  }

  watchServerExit(win);
  await runSmokeHook(win);

  async function runSmokeHook(target) {
    // PI_WEB_DESKTOP_SMOKE_SCREENSHOT=/path/out.png: show what the shell really
    // paints, report the loaded address, and exit. Used by `npm run smoke`.
    const screenshot = process.env.PI_WEB_DESKTOP_SMOKE_SCREENSHOT;
    if (!screenshot) return;
    const resultFile = process.env.PI_WEB_DESKTOP_SMOKE_RESULT || null;
    await delay(2_500);
    const image = await target.webContents.capturePage();
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    fs.writeFileSync(screenshot, image.toPNG());
    const report = {
      ok: true,
      url: target.webContents.getURL(),
      title: target.getTitle(),
      isLoading: target.webContents.isLoading(),
      origin: state.origin,
      server: state.server ? `port ${state.server.port}` : "attached",
      screenshot,
    };
    if (resultFile) fs.writeFileSync(resultFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
    app.quit();
  }

  app.on("activate", () => {
    if (!state.window) {
      const next = createWindow();
      state.window = next;
      void (state.origin
        ? next.loadURL(state.origin)
        : next.loadURL(SPLASH_URL));
    }
  });

  app.on("before-quit", (event) => {
    if (state.quitting) return;
    state.quitting = true;
    const server = state.server;
    if (!server) return;
    // Leave only once the server is down: an app that exits straight away
    // leaves an orphaned server holding the port on POSIX.
    event.preventDefault();
    void Promise.race([server.stop(), delay(12_000)]).finally(() => {
      state.server = null;
      app.quit();
    });
  });
}

app.whenReady().then(main).catch((error) => {
  dialog.showErrorBox(APP_NAME, error instanceof Error ? error.stack ?? error.message : String(error));
  app.exit(1);
});

// A window-less macOS app keeps its server, matching a menu-bar-less agent:
// activating the dock icon reopens the window. Everything else quits.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
