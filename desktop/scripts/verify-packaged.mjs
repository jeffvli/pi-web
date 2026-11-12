#!/usr/bin/env node
// Starts the packaged app's server with the packaged Electron binary acting as
// node, and checks that it answers.
//
// This is the cheap end-to-end proof that a bundle is runnable: the payload was
// installed with production dependencies only, next's server bundle has every
// package it imports, and the launcher chain (app binary → bin/pi-web.js →
// next's bin) resolves inside the bundle. It runs headless: in ELECTRON_RUN_AS_NODE
// mode the binary is a plain node, so no display is needed on any runner.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const options = { dist: join(desktopDir, "dist"), timeoutMs: 90_000 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dist") options.dist = argv[++i] ?? options.dist;
    else if (arg === "--app") options.app = argv[++i];
    else if (arg === "--binary") options.binary = argv[++i];
    else if (arg === "--timeout") options.timeoutMs = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

/** Every unpacked app dir in dist, whichever target produced it. */
function findUnpackedApps(dist) {
  const found = [];
  const stack = [dist];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(current, entry.name);
      if (entry.name === "app" && existsSync(join(full, "bin", "pi-web.js"))) found.push(full);
      else stack.push(full);
    }
  }
  return found;
}

/** The app executable that owns a staged app dir. The macOS layout is recognised
 * from the path, so the suffix comes from the platform that layout implies, not
 * from the host running the build. */
function binaryFor(appDir) {
  const parent = dirname(appDir);
  const grand = dirname(parent);
  // asarUnpack layout, if a build ever produces one: <root>/resources/app.asar.unpacked/app
  const unpackedRoot = parent.endsWith("app.asar.unpacked") ? grand : parent;

  // macOS: <App>.app/Contents/Resources/app
  if (grand.endsWith("Contents")) return join(grand, "MacOS", "pi-web-desktop");

  const suffix = process.platform === "win32" ? ".exe" : "";
  if (unpackedRoot.endsWith("resources") || unpackedRoot === "resources") {
    return join(dirname(unpackedRoot), `pi-web-desktop${suffix}`);
  }
  return null;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function probe(url) {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.text();
  return { ok: response.ok, status: response.status, body };
}

async function main() {
  const options = parseArgs(process.argv);
  const appDir = options.app ?? findUnpackedApps(options.dist)[0];
  if (!appDir) throw new Error(`No unpacked app found in ${options.dist}`);
  const binary = options.binary ?? binaryFor(appDir);
  if (!binary || !existsSync(binary)) throw new Error(`App executable not found for ${appDir}`);

  const stamp = existsSync(join(appDir, "pi-web-desktop.json"))
    ? JSON.parse(readFileSync(join(appDir, "pi-web-desktop.json"), "utf8"))
    : null;

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const logDir = join(tmpdir(), "pi-web-desktop-verify");
  const output = [];

  const child = spawn(binary, [join(appDir, "bin", "pi-web.js"), "-p", String(port), "--no-open"], {
    cwd: appDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PI_WEB_HOSTNAME: "127.0.0.1",
      PI_WEB_NO_OPEN: "1",
      PI_WEB_SKIP_VERSION_CHECK: "1",
      PI_WEB_VERIFY: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const capture = (chunk) => output.push(String(chunk));
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  let exited = null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });

  const deadline = Date.now() + options.timeoutMs;
  let lastFailure = "no attempt made";
  let home = null;

  try {
    while (Date.now() < deadline && !exited) {
      try {
        const root = await probe(`${url}/`);
        if (root.ok && root.body.includes("<")) {
          const sessions = await probe(`${url}/api/sessions`);
          if (sessions.ok && JSON.parse(sessions.body).sessions) {
            home = { root, sessions };
            break;
          }
          lastFailure = `/api/sessions -> HTTP ${sessions.status}`;
        } else {
          lastFailure = `/ -> HTTP ${root.status}`;
        }
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
      }
      await delay(500);
    }
  } finally {
    if (!exited) {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      else child.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => child.on("exit", resolve)), delay(5_000)]);
    }
    rmSync(logDir, { recursive: true, force: true });
  }

  const tail = output.join("").split(/\r?\n/).slice(-40).join("\n");
  if (!home) {
    console.error(`Packaged server did not answer at ${url}: ${lastFailure}`);
    console.error(`exit: ${JSON.stringify(exited)}`);
    console.error(tail);
    process.exit(1);
  }

  const count = JSON.parse(home.sessions.body).sessions.length;
  console.log(
    `Packaged server OK: pi-web ${stamp?.piWebVersion ?? "unknown"}, shell ${stamp?.shellVersion ?? "unknown"}, `
    + `${count} sessions listed at ${url}`,
  );
}

/** True when this file is the entry point, so the module stays importable. */
function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isMain()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export { parseArgs, binaryFor, findUnpackedApps };
