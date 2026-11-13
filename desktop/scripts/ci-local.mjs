#!/usr/bin/env node
// Runs the release build chain locally, in a throwaway git worktree.
//
//   node scripts/ci-local.mjs [--targets "--win --dir"] [--keep] [--out <dir>]
//
// A worktree keeps the repository's .next alone: `next build` here would
// collide with a running dev server, and the chain must run a real production
// build. Uncommitted files from desktop/ are copied in, so the shell can be
// tested before it is committed.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));
const rootDir = dirname(desktopDir);
const repoName = rootDir.split(/[\\/]/).pop();

function parseArgs(argv) {
  const options = {
    out: join(dirname(rootDir), `${repoName}-desktop-local`),
    targets: [],
    keep: false,
    reuse: false,
    maxHeapMb: 8192,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    // electron-builder flags, e.g. --targets="--win --dir". Quoting is easy to
    // lose in a shell, so the common ones also work as their own flags.
    if (arg === "--targets") options.targets = (argv[++i] ?? "").split(/\s+/).filter(Boolean);
    else if (arg.startsWith("--targets=")) options.targets = arg.slice("--targets=".length).split(/\s+/).filter(Boolean);
    else if (arg === "--win" || arg === "--mac" || arg === "--linux" || arg === "--dir") options.targets.push(arg);
    else if (arg === "--arm64" || arg === "--x64") options.targets.push(arg);
    else if (arg === "--out") options.out = resolve(argv[++i] ?? options.out);
    else if (arg === "--max-heap") options.maxHeapMb = Number(argv[++i]);
    else if (arg.startsWith("--max-heap=")) options.maxHeapMb = Number(arg.slice("--max-heap=".length));
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--reuse") options.reuse = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.targets.length === 0) options.targets = ["--win"];
  return options;
}

function git(args, cwd) {
  return spawnSync("git", args, { cwd, stdio: "inherit", env: { ...process.env, NODE_ENV: "" } });
}

function npm(args, cwd, { includeDev = false } = {}) {
  const bin = process.platform === "win32" ? "npm.cmd" : "npm";
  const argv = includeDev ? [...args, "--include=dev"] : args;
  // NODE_ENV=production in a developer's shell sets npm's omit=dev, which would
  // silently drop Electron and every build dependency. shell:true because Node
  // refuses to spawn .cmd files without one.
  return spawnSync(bin, argv, {
    cwd,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, NODE_ENV: "", npm_config_omit: "" },
  });
}

function npx(args, cwd) {
  const bin = process.platform === "win32" ? "npx.cmd" : "npx";
  return spawnSync(bin, args, {
    cwd,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, NODE_ENV: "" },
  });
}

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, NODE_ENV: "" },
  });
}

const steps = [];
function step(name, fn) {
  const started = Date.now();
  process.stdout.write(`\n===== ${name} =====\n`);
  const result = fn();
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (result.status !== 0) {
    console.error(`${name} failed (exit ${result.status ?? "signal"}) after ${seconds}s`);
    process.exit(result.status ?? 1);
  }
  steps.push({ name, seconds });
  console.log(`${name}: OK (${seconds}s)`);
}

function main() {
  const options = parseArgs(process.argv);
  const targets = options.targets.join(" ");
  const desktopCopy = {
    recursive: true,
    filter: (source) => !/(^|[\\/])(node_modules|dist|app-staging|smoke)([\\/]|$)/.test(source.slice(desktopDir.length + 1)),
  };

  if (options.reuse && existsSync(join(options.out, "package.json"))) {
    console.log(`reuse ${options.out}`);
    cpSync(desktopDir, join(options.out, "desktop"), desktopCopy);
  } else {
    step("worktree", () => {
      if (existsSync(options.out)) {
        const list = git(["worktree", "list"], rootDir);
        if (list.status !== 0) return list;
        console.log(`refusing to overwrite ${options.out}; pass --reuse or remove it`);
        process.exit(1);
      }
      const add = git(["worktree", "add", "--detach", options.out, "HEAD"], rootDir);
      if (add.status !== 0) return add;
      cpSync(desktopDir, join(options.out, "desktop"), desktopCopy);
      return { status: 0 };
    });
  }

  step("npm ci (app, with dev deps)", () => npm(["ci", "--no-audit", "--no-fund"], options.out, { includeDev: true }));
  // The webpack build of this app runs out of V8's default heap on a busy
  // developer machine, so the build step names its limit.
  step("npm run build", () => {
    const bin = process.platform === "win32" ? "npm.cmd" : "npm";
    return spawnSync(bin, ["run", "build"], {
      cwd: options.out,
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        NODE_ENV: "",
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${options.maxHeapMb}`.trim(),
      },
    });
  });
  step("npm ci (shell, with dev deps)", () => npm(["ci", "--no-audit", "--no-fund"], join(options.out, "desktop"), { includeDev: true }));
  step("sync version", () => {
    const root = JSON.parse(readFileSync(join(options.out, "package.json"), "utf8"));
    const shellPkg = JSON.parse(readFileSync(join(options.out, "desktop", "package.json"), "utf8"));
    console.log(`Pi Web ${root.version} · shell ${shellPkg.version}`);
    return run(process.execPath, [join(options.out, "desktop", "scripts", "sync-version.mjs"), "--check"], options.out);
  });
  step("stage payload", () => run(process.execPath, [join(options.out, "desktop", "scripts", "prepare-app.mjs")], options.out));
  step(`electron-builder ${targets}`, () => npx(["electron-builder", ...options.targets, "--publish", "never"], join(options.out, "desktop")));
  step("verify packaged server", () => run(process.execPath, [join(options.out, "desktop", "scripts", "verify-packaged.mjs")], join(options.out, "desktop")));

  console.log("\nChain OK:");
  for (const entry of steps) console.log(`  ${entry.name}: ${entry.seconds}s`);

  if (options.keep) {
    console.log(`\nWorktree kept at ${options.out}`);
    console.log(`Installers: ${join(options.out, "desktop", "dist")}`);
  } else {
    step("remove worktree", () => git(["worktree", "remove", "--force", options.out], rootDir));
    git(["worktree", "prune"], rootDir);
  }
}

main();
