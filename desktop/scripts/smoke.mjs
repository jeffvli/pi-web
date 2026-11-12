#!/usr/bin/env node
// Runs the shell against a running Pi Web server, captures the window it paints
// and reports the address it loaded. A quick check of the parts that only exist
// at runtime: window creation, remote content load, the origin guard, the menus.
//
//   node scripts/smoke.mjs [--server-url http://127.0.0.1:30141]
//
// Requires a display. CI verifies the payload headless with verify-packaged.mjs.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(desktopDir, "package.json"));

function parseArgs(argv) {
  const options = {
    serverUrl: process.env.PI_WEB_DESKTOP_SERVER_URL || "http://127.0.0.1:30141",
    out: join(desktopDir, "smoke"),
    timeoutMs: 120_000,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--server-url") options.serverUrl = argv[++i] ?? options.serverUrl;
    else if (arg.startsWith("--server-url=")) options.serverUrl = arg.slice("--server-url=".length);
    else if (arg === "--out") options.out = resolve(argv[++i] ?? options.out);
    else if (arg === "--timeout") options.timeoutMs = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv);

  let reachable = false;
  try {
    reachable = (await fetch(options.serverUrl, { cache: "no-store" })).ok;
  } catch {
    // Reported below.
  }
  if (!reachable) {
    throw new Error(
      `No Pi Web server answers at ${options.serverUrl}. Start one: \`npm run dev\` in the repo root, `
      + "or pass --server-url for a running server.",
    );
  }

  const binary = require("electron");
  const screenshot = join(options.out, "window.png");
  const resultFile = join(options.out, "result.json");
  mkdirSync(options.out, { recursive: true });
  rmSync(resultFile, { force: true });

  const child = spawn(binary, [desktopDir, "--server-url", options.serverUrl], {
    cwd: desktopDir,
    env: {
      ...process.env,
      PI_WEB_DESKTOP_SMOKE_SCREENSHOT: screenshot,
      PI_WEB_DESKTOP_SMOKE_RESULT: resultFile,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  const deadline = Date.now() + options.timeoutMs;
  let result = null;
  let exitInfo = null;
  child.on("exit", (code, signal) => {
    exitInfo = { code, signal };
  });

  while (!result && Date.now() < deadline && !exitInfo) {
    if (existsSync(resultFile)) {
      try {
        result = JSON.parse(readFileSync(resultFile, "utf8"));
      } catch {
        // The file was still being written.
      }
    }
    if (!result) await delay(500);
  }

  if (!result) {
    if (!exitInfo) child.kill("SIGTERM");
    throw new Error(`No smoke result within ${Math.round(options.timeoutMs / 1000)}s (electron ${JSON.stringify(exitInfo ?? "running")})`);
  }

  console.log(JSON.stringify(result, null, 2));
  if (!result.url.startsWith(options.serverUrl)) throw new Error(`Window loaded ${result.url}, expected ${options.serverUrl}`);
  console.log(`Screenshot: ${screenshot}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
