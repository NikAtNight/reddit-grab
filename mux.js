// Chrome offscreen document entry point. Firefox performs the same operation
// directly from its background document.

import { muxToBlobUrl } from "./mux-lib.js";

const api = typeof browser !== "undefined" ? browser : chrome;

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "mux") return undefined;

  if (message.type === "merge-streams") {
    muxToBlobUrl(message.videoUrl, message.audioUrl)
      .then((blobUrl) => sendResponse({ ok: true, blobUrl }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "release-blob") {
    URL.revokeObjectURL(message.blobUrl);
    sendResponse({ ok: true });
  }
  return undefined;
});
