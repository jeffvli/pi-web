"use strict";

// Runs the Pi Web server as a child process of this Electron app.
//
// Electron's main process is Node, and the packaged app binary re-execs itself
// with ELECTRON_RUN_AS_NODE set (see `start`): the same executable then
// behaves as a plain `node`, which is what upstream's bin/pi-web.js launcher
// expects. That launcher in turn spawns `process.execPath` with next's own bin,
// so the whole chain runs on Electron's bundled Node with no second runtime.
// A bare launcher invocation is the server: `pi-web` has no `start` subcommand.
//
// Nothing here imports Pi Web code: the server is a separate process, so a
// server crash can never take the window down with it.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const READY_TIMEOUT_MS = 120_000;
const READY_PROBE_MS = 250;
const LOG_TAIL_LINES = 60;

/** An address the webview can load and that Pi Web's host check accepts. */
function loopbackUrl(port) {
  return `http://127.0.0.1:${port}`;
}

/** Ask the OS for a free loopback port, then release it for Pi Web to claim. */
async function findFreePort(host = "127.0.0.1") {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("No free loopback port"))));
    });
  });
}

/**
 * Resolve once the server answers. A 401 counts: a server with PI_WEB_PASSWORD
 * set is up, and the window can show its login page.
 */
async function waitForServer(url, { timeoutMs = READY_TIMEOUT_MS, label = url } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "no attempt made";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok || response.status === 401) return;
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await delay(READY_PROBE_MS);
  }

  throw new Error(`Pi Web did not answer at ${url} within ${Math.round(timeoutMs / 1000)}s (${lastFailure})`);
}

/**
 * A supervised Pi Web server process.
 *
 * Lifecycle: `start()` spawns the launcher and resolves once the server answers;
 * `stop()` shuts the tree down. `whenExited` resolves with the exit info, which
 * the window layer uses to tell the user about a server that died on its own.
 */
class PiWebServer {
  constructor({ appDir, logFile, port, env = {}, label = "Pi Web" }) {
    this.appDir = appDir;
    this.logFile = logFile;
    this.port = port;
    this.extraEnv = env;
    this.label = label;
    this.url = loopbackUrl(port);
    this.child = null;
    this.stopping = false;
    this.tail = [];
    this.exitInfo = null;
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  /** Last lines of the child's output, for the failure dialog. */
  get outputTail() {
    return this.tail.join("\n");
  }

  async start({ timeoutMs = READY_TIMEOUT_MS } = {}) {
    const launcher = path.join(this.appDir, "bin", "pi-web.js");
    if (!fs.existsSync(launcher)) {
      throw new Error(`Pi Web launcher not found: ${launcher}`);
    }
    if (!fs.existsSync(path.join(this.appDir, ".next"))) {
      throw new Error(`Pi Web build artifacts not found in ${this.appDir} (run desktop/scripts/prepare-app.mjs)`);
    }

    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    const logStream = fs.createWriteStream(this.logFile, { flags: "a" });
    logStream.write(`\n===== ${new Date().toISOString()} desktop shell: start =====\n`);

    // The launcher is a plain Node script, so the app binary runs it as node.
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      // The window loads this origin, so Pi Web's Host/Origin checks pass as
      // ordinary same-origin browser traffic.
      PI_WEB_HOSTNAME: "127.0.0.1",
      // The shell owns the window: no browser open, and no npm self-update
      // check inside a bundle the user cannot `npm update`.
      PI_WEB_NO_OPEN: "1",
      PI_WEB_SKIP_VERSION_CHECK: "1",
      PI_WEB_DESKTOP: "1",
      PI_WEB_DESKTOP_SHELL_VERSION: this.extraEnv.PI_WEB_DESKTOP_SHELL_VERSION ?? "",
      ...this.extraEnv,
    };
    delete env.PORT;

    // A bare launcher invocation starts the server: `pi-web` has no `start`.
    this.child = spawn(process.execPath, [launcher, "-p", String(this.port), "--no-open"], {
      cwd: this.appDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const capture = (chunk) => {
      const text = String(chunk);
      logStream.write(text);
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.tail.push(line);
        if (this.tail.length > LOG_TAIL_LINES) this.tail.shift();
      }
    };
    this.child.stdout?.on("data", capture);
    this.child.stderr?.on("data", capture);

    this.child.on("error", (error) => {
      logStream.write(`spawn error: ${error?.message ?? error}\n`);
      this.finish({ code: null, signal: null, error });
    });
    this.child.on("exit", (code, signal) => {
      logStream.write(`===== ${new Date().toISOString()} exited (code=${code} signal=${signal}) =====\n`);
      logStream.end();
      this.finish({ code, signal });
    });

    try {
      await waitForServer(this.url, { timeoutMs, label: this.url });
    } catch (error) {
      await this.stop();
      throw error;
    }
    return this.url;
  }

  /**
   * POSIX: SIGTERM reaches the launcher, which forwards it to next (its own
   * process-lifecycle wiring) so extensions get their shutdown deadline.
   * Windows has no signal to forward, so the whole tree is killed.
   */
  async stop({ graceMs = 8_000 } = {}) {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return this.exited;
    this.stopping = true;

    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      const withinGrace = await Promise.race([
        this.exited.then(() => true),
        delay(graceMs).then(() => false),
      ]);
      if (!withinGrace) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }

    await Promise.race([this.exited, delay(graceMs)]);
  }

  finish(info) {
    if (this.exitInfo) return;
    this.exitInfo = info;
    this.resolveExit(info);
  }

  get exitStatus() {
    return this.exitInfo;
  }
}

module.exports = { PiWebServer, findFreePort, waitForServer, loopbackUrl };
