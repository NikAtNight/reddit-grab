import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modules = resolve(root, "node_modules", "@ffmpeg");
const ffmpegTarget = resolve(root, "vendor", "ffmpeg");
const coreTarget = resolve(root, "vendor", "core");
const ffmpegPackage = JSON.parse(await readFile(resolve(modules, "ffmpeg", "package.json"), "utf8"));
const corePackage = JSON.parse(await readFile(resolve(modules, "core", "package.json"), "utf8"));

if (ffmpegPackage.version !== "0.12.15" || corePackage.version !== "0.12.10") {
  throw new Error("Installed ffmpeg versions do not match package.json");
}

await rm(ffmpegTarget, { recursive: true, force: true });
await rm(coreTarget, { recursive: true, force: true });
await mkdir(ffmpegTarget, { recursive: true });
await mkdir(coreTarget, { recursive: true });
await cp(resolve(modules, "ffmpeg", "dist", "esm"), ffmpegTarget, { recursive: true });
await cp(resolve(modules, "core", "dist", "esm", "ffmpeg-core.js"), resolve(coreTarget, "ffmpeg-core.js"));
await cp(resolve(modules, "core", "dist", "esm", "ffmpeg-core.wasm"), resolve(coreTarget, "ffmpeg-core.wasm"));

const workerPath = resolve(ffmpegTarget, "worker.js");
let worker = await readFile(workerPath, "utf8");
worker = worker.replace(
  'import { CORE_URL, FFMessageType } from "./const.js";',
  'import { FFMessageType } from "./const.js";\nimport createFFmpegCore from "../core/ffmpeg-core.js";'
);
worker = worker.replace(
  "ERROR_UNKNOWN_MESSAGE_TYPE, ERROR_NOT_LOADED, ERROR_IMPORT_FAILURE,",
  "ERROR_UNKNOWN_MESSAGE_TYPE, ERROR_NOT_LOADED,"
);
const dynamicLoader = `    try {
        if (!_coreURL)
            _coreURL = CORE_URL;
        // when web worker type is \`classic\`.
        importScripts(_coreURL);
    }
    catch {
        if (!_coreURL || _coreURL === CORE_URL)
            _coreURL = CORE_URL.replace('/umd/', '/esm/');
        // when web worker type is \`module\`.
        self.createFFmpegCore = (await import(
        /* @vite-ignore */ _coreURL)).default;
        if (!self.createFFmpegCore) {
            throw ERROR_IMPORT_FAILURE;
        }
    }`;
const packagedLoader = `    if (!_coreURL)
        _coreURL = new URL("../core/ffmpeg-core.js", import.meta.url).href;
    self.createFFmpegCore = createFFmpegCore;`;
if (!worker.includes(dynamicLoader)) throw new Error("Upstream ffmpeg worker loader changed");
worker = worker.replace(dynamicLoader, packagedLoader);
await writeFile(workerPath, worker);

await writeFile(
  resolve(ffmpegTarget, "LICENSE"),
  "@ffmpeg/ffmpeg 0.12.15\nSPDX-License-Identifier: MIT\nhttps://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/LICENSE\n"
);
await writeFile(
  resolve(coreTarget, "LICENSE"),
  "@ffmpeg/core 0.12.10\nSPDX-License-Identifier: GPL-2.0-or-later\nhttps://www.gnu.org/licenses/old-licenses/gpl-2.0.html\nSource: https://github.com/ffmpegwasm/ffmpeg.wasm\n"
);
