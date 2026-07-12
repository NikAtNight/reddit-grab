// Offscreen-document entry point (Chrome). Receives mux jobs from the
// background service worker, returns a blob: URL, and revokes it when told
// the download has finished. Firefox skips this file entirely — its
// background page imports mux-lib.js directly.

import { muxToBlobUrl } from "./mux-lib.js";

const api = typeof browser !== "undefined" ? browser : chrome;

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "mux") {
    muxToBlobUrl(msg.videoUrl, msg.audioUrl)
      .then((blobUrl) => sendResponse({ ok: true, blobUrl }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }
  if (msg?.type === "mux-release") {
    URL.revokeObjectURL(msg.blobUrl);
  }
});
