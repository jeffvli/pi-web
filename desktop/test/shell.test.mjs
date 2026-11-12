import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiWebServer, findFreePort, loopbackUrl, waitForServer } from "../server-process.js";
import { binaryFor, findUnpackedApps } from "../scripts/verify-packaged.mjs";

const suffix = process.platform === "win32" ? ".exe" : "";

test("the webview address is a loopback IP, which Pi Web's host check accepts", () => {
  assert.equal(loopbackUrl(30141), "http://127.0.0.1:30141");
});

test("findFreePort returns a usable port", async () => {
  const port = await findFreePort();
  assert.ok(port > 1024 && port <= 65535, `port ${port}`);
});

test("waitForServer resolves once the server answers", async () => {
  const server = createServer((_request, response) => response.writeHead(200).end("<html></html>"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await waitForServer(loopbackUrl(port), { timeoutMs: 5_000 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a password-protected server counts as up", async () => {
  const server = createServer((_request, response) => response.writeHead(401).end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await waitForServer(loopbackUrl(port), { timeoutMs: 5_000 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("waitForServer says which address it gave up on", async () => {
  const port = await findFreePort();
  await assert.rejects(
    () => waitForServer(loopbackUrl(port), { timeoutMs: 1_200 }),
    (error) => error.message.includes(`http://127.0.0.1:${port}`) && error.message.includes("within 1s"),
  );
});

test("the app executable is found for every packaging layout", () => {
  assert.equal(
    binaryFor(join("dist", "win-unpacked", "resources", "app")),
    join("dist", "win-unpacked", `pi-web-desktop${suffix}`),
  );
  assert.equal(
    binaryFor(join("dist", "linux-unpacked", "resources", "app")),
    join("dist", "linux-unpacked", `pi-web-desktop${suffix}`),
  );
  assert.equal(
    binaryFor(join("dist", "mac-arm64", "Pi Web.app", "Contents", "Resources", "app")),
    join("dist", "mac-arm64", "Pi Web.app", "Contents", "MacOS", "pi-web-desktop"),
  );
  assert.equal(binaryFor(join("somewhere", "else")), null);
});

test("findUnpackedApps finds the payload in dist and ignores the rest", () => {
  const dist = mkdtempSync(join(tmpdir(), "pi-web-desktop-dist-"));
  try {
    const app = join(dist, "win-unpacked", "resources", "app");
    mkdirSync(join(app, "bin"), { recursive: true });
    writeFileSync(join(app, "bin", "pi-web.js"), "#!/usr/bin/env node\n");
    mkdirSync(join(dist, "win-unpacked", "resources"), { recursive: true });
    mkdirSync(join(dist, "latest-distractor", "app"), { recursive: true });

    const found = findUnpackedApps(dist);
    assert.deepEqual(found, [app]);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("PiWebServer reports a missing payload before it spawns anything", async () => {
  const empty = mkdtempSync(join(tmpdir(), "pi-web-desktop-empty-"));
  try {
    const server = new PiWebServer({ appDir: empty, logFile: join(empty, "server.log"), port: 45999 });
    await assert.rejects(() => server.start(), /launcher not found/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
