"use strict";

// electron-builder afterPack hook: copy the staged Pi Web payload into the
// unpacked app as resources/app.
//
// electron-builder's file matcher removes `**/node_modules/**` from every user
// file set, so the payload cannot be declared in `files` or `extraResources`:
// the packaged server starts and then dies on `Cannot find module 'next'`.
// A copy straight onto disk is also what the server wants — next reads its own
// .next files with plain fs and spawns scripts from bin/, neither of which
// resolves inside an asar.
//
// Runs after packing and before the installer is built, so NSIS/MSI/dmg/AppImage
// all contain the tree.

const { cpSync, existsSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const desktopDir = dirname(__dirname);

/** The resources dir of the unpacked app, for every platform's layout. */
function resourcesDirOf(context) {
  const appOutDir = context.appOutDir;
  if (context.electronPlatformName === "darwin") {
    // <output>/<App>.app/Contents
    const contents = join(appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents");
    if (existsSync(contents)) return join(contents, "Resources");
  }
  return join(appOutDir, "resources");
}

module.exports = async function afterPack(context) {
  const staged = join(desktopDir, "app-staging");
  for (const required of [join("bin", "pi-web.js"), join(".next", "BUILD_ID"), "node_modules"]) {
    if (!existsSync(join(staged, required))) {
      throw new Error(
        `app-staging is incomplete: missing ${required}. `
        + "Run `node scripts/prepare-app.mjs` before electron-builder.",
      );
    }
  }

  const resources = resourcesDirOf(context);
  const target = join(resources, "app");
  const log = context.packager?.log?.info
    ? (message) => context.packager.log.info({ message })
    : (message) => process.stdout.write(`${message}\n`);

  log(`copying the Pi Web payload into ${target}`);
  cpSync(staged, target, { recursive: true, force: true });

  const stamp = join(target, "pi-web-desktop.json");
  if (existsSync(stamp)) {
    const info = JSON.parse(readFileSync(stamp, "utf8"));
    log(`payload: Pi Web ${info.piWebVersion}, ${info.files} files, ${info.mb} MB`);
  }
};
