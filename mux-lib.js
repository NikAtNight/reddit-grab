// Losslessly combines Reddit's separate MP4 video and audio streams.

import { FFmpeg } from "./vendor/ffmpeg/index.js";

const api = typeof browser !== "undefined" ? browser : chrome;

async function fetchBytes(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} stream returned ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function muxToBlobUrl(videoUrl, audioUrl) {
  const [videoBytes, audioBytes] = await Promise.all([
    fetchBytes(videoUrl, "Video"),
    fetchBytes(audioUrl, "Audio"),
  ]);
  const ffmpeg = new FFmpeg();

  try {
    await ffmpeg.load({
      coreURL: api.runtime.getURL("vendor/core/ffmpeg-core.js"),
      wasmURL: api.runtime.getURL("vendor/core/ffmpeg-core.wasm"),
    });
    await ffmpeg.writeFile("video.mp4", videoBytes);
    await ffmpeg.writeFile("audio.mp4", audioBytes);
    const exitCode = await ffmpeg.exec([
      "-i",
      "video.mp4",
      "-i",
      "audio.mp4",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "output.mp4",
    ]);
    if (exitCode !== 0) throw new Error(`ffmpeg exited with status ${exitCode}`);
    const output = await ffmpeg.readFile("output.mp4");
    return URL.createObjectURL(new Blob([output], { type: "video/mp4" }));
  } finally {
    try {
      ffmpeg.terminate();
    } catch {
      // Loading may have failed before the worker was created.
    }
  }
}
