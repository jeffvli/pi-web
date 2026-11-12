#!/usr/bin/env node
// Builds the Pi Web app folder that ships inside the desktop bundle.
//
// Same shape as the published npm package — bin, .next, public, next.config.ts,
// package.json (see the package's `files` field) — plus production dependencies
// installed into it. The desktop app then runs `bin/pi-web.js` from there, so
// what ships is what `npm install -g @agegr/pi-web` gives a CLI user.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = dirname(scriptDir);
const rootDir = dirname(desktopDir);

const COPY_ENTRIES = ["package.json", "package-lock.json", "next.config.ts", "bin", "public", ".next"];

// A dev server writes .next/dev, its lock and a bundler cache beside the
// production build. The cache alone is often larger than the app.
const EXCLUDE_PATHS = [
  join(".next", "cache"),
  join(".next", "dev"),
  join(".next", "lock"),
  join(".next", "trace"),
  join(".next", "trace-server"),
  join(".next", "diagnostics"),
];

const EXCLUDE_SUFFIXES = [".js.map", ".map", ".tsbuildinfo", ".log", ".test.mjs"];

function parseArgs(argv) {
  const options = { out: join(desktopDir, "app-staging"), install: true, clean: true };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" || arg === "--output") options.out = resolve(argv[++i] ?? options.out);
    else if (arg.startsWith("--out=")) options.out = resolve(arg.slice("--out=".length));
    else if (arg === "--no-install") options.install = false;
    else if (arg === "--no-clean") options.clean = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function makeFilter() {
  const excluded = [];
  return {
    // cpSync calls this with the source path of every entry, top down.
    filter: (source) => {
      const rel = relative(rootDir, source);
      if (!rel) return true;
      const isExcluded = EXCLUDE_PATHS.some((bad) => rel === bad || rel.startsWith(`${bad}${sep}`))
        || EXCLUDE_SUFFIXES.some((suffix) => rel.endsWith(suffix));
      if (isExcluded) {
        excluded.push(rel);
        return false;
      }
      return true;
    },
    excluded,
  };
}

function measure(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        bytes += statSync(full).size;
        files += 1;
      }
    }
  }
  return { bytes, files };
}

function main() {
  const options = parseArgs(process.argv);
  const rootPkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));

  if (!existsSync(join(rootDir, ".next", "BUILD_ID"))) {
    throw new Error(`No production build at ${join(rootDir, ".next")}. Run \`npm run build\` in ${rootDir} first.`);
  }

  if (options.clean) rmSync(options.out, { recursive: true, force: true });

  const { filter, excluded } = makeFilter();
  for (const entry of COPY_ENTRIES) {
    const source = join(rootDir, entry);
    if (!existsSync(source)) {
      if (entry === ".next" || entry === "bin") throw new Error(`Missing ${entry} in ${rootDir}`);
      console.warn(`skip ${entry}: not present`);
      continue;
    }
    cpSync(source, join(options.out, entry), { recursive: true, filter });
  }

  if (options.install) {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    // shell:true: Node refuses to spawn .cmd files without a shell.
    const result = spawnSync(npm, ["ci", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=warn"], {
      cwd: options.out,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, NODE_ENV: "", npm_config_omit: "" },
    });
    if (result.status !== 0) {
      throw new Error(`npm ci --omit=dev failed in ${options.out} (exit ${result.status ?? "signal"})`);
    }
  }

  const { bytes, files } = measure(options.out);
  const shellPkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
  writeFileSync(
    join(options.out, "pi-web-desktop.json"),
    `${JSON.stringify(
      {
        piWebVersion: rootPkg.version,
        shellVersion: shellPkg.version,
        builtAt: new Date().toISOString(),
        builtByNode: process.versions.node,
        files,
        mb: Math.round(bytes / (1024 * 1024)),
      },
      null,
      2,
    )}\n`,
  );

  console.log(`Staged ${files} files, ${Math.round(bytes / (1024 * 1024))} MB at ${options.out}`);
  if (excluded.length) console.log(`Excluded ${excluded.length} build-cache/map/dev paths.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
