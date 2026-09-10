import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

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
  const target = resolve(dist, browser);
  await copyAllowlist(target);
  const manifest = await readFile(resolve(root, "manifests", `${browser}.json`), "utf8");
  await writeFile(resolve(target, "manifest.json"), manifest);
}

await rm(dist, { recursive: true, force: true });
await Promise.all([buildBrowser("chrome"), buildBrowser("firefox")]);
