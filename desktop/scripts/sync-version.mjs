#!/usr/bin/env node
// Keeps desktop/package.json's version equal to the upstream app's version.
//
// The release is the app: a `v0.16.0` tag means a desktop build of Pi Web
// 0.16.0, so the shell never carries its own number. CI runs `--check` to fail
// a tag whose package.json does not match, mirroring publish.yml's check-tag.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));
const rootPkgPath = join(dirname(desktopDir), "package.json");
const shellPkgPath = join(desktopDir, "package.json");

const mode = process.argv[2] === "--check" ? "check" : process.argv[2] === "--print" ? "print" : "write";

const rootVersion = JSON.parse(readFileSync(rootPkgPath, "utf8")).version;
const shellPkg = JSON.parse(readFileSync(shellPkgPath, "utf8"));

if (mode === "print") {
  console.log(rootVersion);
} else if (mode === "check") {
  if (shellPkg.version !== rootVersion) {
    console.error(`desktop/package.json version ${shellPkg.version} != Pi Web ${rootVersion}`);
    process.exit(1);
  }
  console.log(`desktop shell version matches Pi Web ${rootVersion}`);
} else {
  if (shellPkg.version === rootVersion) {
    console.log(`desktop/package.json already at ${rootVersion}`);
  } else {
    shellPkg.version = rootVersion;
    writeFileSync(shellPkgPath, `${JSON.stringify(shellPkg, null, 2)}\n`);
    console.log(`desktop/package.json version -> ${rootVersion}`);
  }
}
