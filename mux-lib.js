// Reddit Image Grab — ffmpeg.wasm muxing. Merges a v.redd.it video stream and
// its separate audio stream into one MP4 (stream copy, no re-encode).
// Runs in an extension page context: the offscreen document on Chrome, the
// background event page on Firefox. Not usable from a service worker (the
// ffmpeg wrapper needs Worker + blob URLs).

import { FFmpeg } from "./vendor/ffmpeg/index.js";

const runtime = (typeof browser !== "undefined" ? browser : chrome).runtime;

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status} for ${new URL(url).pathname}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Returns a blob: URL for the muxed MP4. Caller must revoke it when done.
export async function muxToBlobUrl(videoUrl, audioUrl) {
  const [video, audio] = await Promise.all([fetchBytes(videoUrl), fetchBytes(audioUrl)]);

  const ffmpeg = new FFmpeg();
  try {
    await ffmpeg.load({
      coreURL: runtime.getURL("vendor/core/ffmpeg-core.js"),
      wasmURL: runtime.getURL("vendor/core/ffmpeg-core.wasm"),
    });
    await ffmpeg.writeFile("v.mp4", video);
    await ffmpeg.writeFile("a.mp4", audio);
    const code = await ffmpeg.exec([
      "-i", "v.mp4",
      "-i", "a.mp4",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c", "copy",
      "out.mp4",
    ]);
    if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
    const out = await ffmpeg.readFile("out.mp4");
    return URL.createObjectURL(new Blob([out], { type: "video/mp4" }));
  } finally {
    // Free the ~wasm heap; a fresh instance is loaded per mux.
    try {
      ffmpeg.terminate();
    } catch {
      /* never loaded */
    }
  }
}
