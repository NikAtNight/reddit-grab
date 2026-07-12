// Reddit Image Grab — background script (service worker on Chrome, event page
// on Firefox). Receives image URL lists from the content script and saves them
// via the downloads API into the configured subfolder of the browser's
// Downloads directory (extensions are not allowed to write anywhere else).

// Firefox exposes the promise-based `browser` namespace; Chrome's `chrome`
// namespace is promise-based in MV3, so the two are interchangeable here.
const api = typeof browser !== "undefined" ? browser : chrome;

// "PhotoVault Inbox" in Downloads is a symlink to ~/PhotoVault Inbox, so
// downloads land there while staying inside the Downloads sandbox.
const DEFAULTS = { folder: "PhotoVault Inbox", bySubreddit: false };

function sanitize(part) {
  const cleaned = String(part)
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 80);
  return cleaned || "reddit";
}

// The folder setting may contain "/" for nesting; sanitize each segment.
function sanitizePath(path) {
  return String(path)
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(sanitize)
    .join("/");
}

function extFromUrl(url) {
  const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : "jpg";
}

// ------------------------------------------------------------------ muxing
// v.redd.it publishes video and audio as separate streams; ffmpeg.wasm merges
// them into one MP4. Chrome: runs in an offscreen document (service workers
// can't host ffmpeg's Worker). Firefox: the background event page runs it
// directly via dynamic import.

const blobsByDownload = new Map(); // downloadId -> blob URL to revoke

async function ensureOffscreen() {
  try {
    await api.offscreen.createDocument({
      url: "mux.html",
      reasons: ["WORKERS"],
      justification: "Merge Reddit video and audio streams with ffmpeg.wasm",
    });
  } catch (err) {
    if (!String(err.message).includes("single offscreen")) throw err;
  }
}

async function muxStreams(videoUrl, audioUrl) {
  if (api.offscreen) {
    await ensureOffscreen();
    const reply = await api.runtime.sendMessage({ type: "mux", videoUrl, audioUrl });
    if (!reply?.ok) throw new Error(reply?.error || "mux failed");
    return reply.blobUrl;
  }
  // Firefox: background is an event page with a DOM — run ffmpeg here.
  const { muxToBlobUrl } = await import(api.runtime.getURL("mux-lib.js"));
  return muxToBlobUrl(videoUrl, audioUrl);
}

function releaseBlob(blobUrl) {
  if (api.offscreen) {
    api.runtime.sendMessage({ type: "mux-release", blobUrl }).catch(() => {});
  } else {
    URL.revokeObjectURL(blobUrl);
  }
}

api.downloads.onChanged.addListener(({ id, state }) => {
  if (!state || !blobsByDownload.has(id)) return;
  if (state.current === "complete" || state.current === "interrupted") {
    releaseBlob(blobsByDownload.get(id));
    blobsByDownload.delete(id);
  }
});

async function downloadMedia({ files, subreddit, postId }) {
  const { folder, bySubreddit } = await api.storage.sync.get(DEFAULTS);

  const parts = [];
  const folderPath = sanitizePath(folder || "");
  if (folderPath) parts.push(folderPath);
  if (bySubreddit) parts.push(sanitize(subreddit));
  const dir = parts.length ? parts.join("/") + "/" : "";
  const save = async (url, suffix, ext) => {
    const filename = `${dir}${sanitize(postId)}${suffix || ""}.${ext || extFromUrl(url)}`;
    return api.downloads.download({ url, filename, conflictAction: "uniquify" });
  };

  let count = 0;
  for (const entry of files) {
    if (entry.mux) {
      try {
        const blobUrl = await muxStreams(entry.mux.video, entry.mux.audio);
        const id = await save(blobUrl, entry.suffix, "mp4");
        blobsByDownload.set(id, blobUrl);
        count++;
        continue;
      } catch (err) {
        console.warn("[Reddit Image Grab] mux failed, saving separate streams:", err);
        await save(entry.mux.video, entry.suffix);
        await save(entry.mux.audio, `${entry.suffix || ""}_audio`);
        count += 2;
        continue;
      }
    }
    await save(entry.url, entry.suffix);
    count++;
  }
  return count;
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "download-images") {
    downloadMedia(msg)
      .then((count) => sendResponse({ ok: true, count }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }
});

// Toolbar icon: forward to the content script of the active tab.
api.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  api.tabs.sendMessage(tab.id, { type: "download-current" }).catch(() => {
    // No content script on this page (not reddit.com) — nothing to do.
  });
});
