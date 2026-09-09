import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

test("browser manifests share identity, hosts, and content scripts", async () => {
  const chrome = await readJson("manifests/chrome.json");
  const firefox = await readJson("manifests/firefox.json");

  assert.equal(chrome.manifest_version, 3);
  assert.equal(firefox.manifest_version, 3);
  assert.equal(chrome.name, firefox.name);
  assert.equal(chrome.version, firefox.version);
  assert.deepEqual(chrome.host_permissions, firefox.host_permissions);
  assert.deepEqual(chrome.content_scripts, firefox.content_scripts);
  assert.deepEqual(chrome.content_scripts[0].matches, [
    "*://reddit.com/*",
    "*://*.reddit.com/*",
  ]);
  assert.deepEqual(chrome.content_scripts[0].js, ["reddit-media.js", "content.js", "reddit-feeds.js", "custom-feeds.js"]);
  assert.ok(chrome.host_permissions.includes("*://v.redd.it/*"));
});

test("Chrome uses a service worker and offscreen permission only", async () => {
  const chrome = await readJson("manifests/chrome.json");

  assert.deepEqual(chrome.background, { service_worker: "background.js" });
  assert.ok(chrome.permissions.includes("offscreen"));
  assert.ok(chrome.permissions.includes("activeTab"));
  assert.ok(chrome.permissions.includes("scripting"));
  assert.equal(chrome.browser_specific_settings, undefined);
  assert.ok(Number.parseInt(chrome.minimum_chrome_version, 10) >= 121);
});

test("Firefox uses background scripts and declares current privacy metadata", async () => {
  const firefox = await readJson("manifests/firefox.json");

  assert.deepEqual(firefox.background, { scripts: ["reddit-media.js", "background.js"] });
  assert.ok(!firefox.permissions.includes("offscreen"));
  assert.ok(firefox.permissions.includes("activeTab"));
  assert.ok(firefox.permissions.includes("scripting"));
  assert.equal(firefox.minimum_chrome_version, undefined);
  assert.equal(firefox.browser_specific_settings.gecko.id, "reddit-grab@talix.dev");
  assert.deepEqual(
    firefox.browser_specific_settings.gecko.data_collection_permissions.required,
    ["none"]
  );
});

test("build emits isolated browser packages from the strict allowlist", async () => {
  await execFileAsync(process.execPath, ["scripts/build.mjs"], { cwd: root });

  const allowedTopLevel = [
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "background.js",
    "content.js",
    "custom-feeds.js",
    "reddit-feeds.js",
    "icons",
    "manifest.json",
    "mux-lib.js",
    "mux.html",
    "mux.js",
    "options.html",
    "options.js",
    "reddit-media.js",
    "vendor",
  ].sort();

  for (const browser of ["chrome", "firefox"]) {
    const files = (await readdir(resolve(root, "dist", browser))).sort();
    assert.deepEqual(files, allowedTopLevel);
    assert.deepEqual(
      await readJson(`dist/${browser}/manifest.json`),
      await readJson(`manifests/${browser}.json`)
    );
  }
});
