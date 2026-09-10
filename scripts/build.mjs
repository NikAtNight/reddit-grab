import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const privateBuild = process.argv.slice(2).includes("--private");
if (process.argv.slice(2).some(arg => arg !== "--private")) throw new Error("Usage: node scripts/build.mjs [--private]");
const providerDirectory = resolve(root, ".local-providers");
const providerConfig = privateBuild ? JSON.parse(await readFile(resolve(providerDirectory, "config.json"), "utf8")) : null;
if (privateBuild && (!Array.isArray(providerConfig.host_permissions) || providerConfig.host_permissions.some(host => typeof host !== "string"))) {
  throw new Error("Local provider config must supply a host_permissions array.");
}
const providerSource = privateBuild ? await readFile(resolve(providerDirectory, "provider.js"), "utf8") : null;

const sharedFiles = [
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "background.js",
  "content.js",
  "reddit-feeds.js",
  "reddit-requests.js",
  "download-recovery.js",
  "custom-feeds.js",
  "reddit-media.js",
  "mux-lib.js",
  "mux.html",
  "mux.js",
  "options.html",
  "options.js",
];

const sharedDirectories = ["icons", "vendor"];

async function copyAllowlist(target) {
  await mkdir(target, { recursive: true });
  await Promise.all(
    sharedFiles.map((file) => cp(resolve(root, file), resolve(target, file)))
  );
  await Promise.all(
    sharedDirectories.map((directory) =>
      cp(resolve(root, directory), resolve(target, directory), { recursive: true })
    )
  );
}

async function buildBrowser(browser) {
  const target = resolve(dist, ...(privateBuild ? ["private"] : []), browser);
  await rm(target, { recursive: true, force: true });
  await copyAllowlist(target);
  const manifest = JSON.parse(await readFile(resolve(root, "manifests", `${browser}.json`), "utf8"));
  if (privateBuild) {
    await writeFile(resolve(target, "local-provider.js"), providerSource);
    manifest.host_permissions = [...new Set([...manifest.host_permissions, ...providerConfig.host_permissions])];
    for (const script of manifest.content_scripts) script.js.unshift("local-provider.js");
    if (manifest.background.scripts) manifest.background.scripts.unshift("local-provider.js");
    else {
      const background = resolve(target, manifest.background.service_worker);
      await writeFile(background, 'importScripts("local-provider.js");\n' + await readFile(background, "utf8"));
    }
  }
  await writeFile(resolve(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

await Promise.all([buildBrowser("chrome"), buildBrowser("firefox")]);
