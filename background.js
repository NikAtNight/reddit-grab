// Reddit Media Grab — privileged network, muxing, and downloads.

if (!globalThis.RedditGrabMedia && typeof importScripts === "function") {
  importScripts("reddit-media.js");
}

if (!globalThis.RedditGrabRequests && typeof importScripts === "function") importScripts("reddit-requests.js");
if (!globalThis.RedditGrabRecovery && typeof importScripts === "function") importScripts("download-recovery.js");

const api = typeof browser !== "undefined" ? browser : chrome;
const requestBroker = globalThis.RedditGrabRequests.createBroker({
  storage: api.storage.local,
  execute: async (request, context) => {
    const result = await api.tabs.sendMessage(context.tabId, { type: "reddit-grab-execute-request", request }, { frameId: 0 });
    if (!result?.ok) throw new Error(result?.error || "The Reddit tab closed or reloaded before the request finished");
    return result.value;
  },
});
const recovery = globalThis.RedditGrabRecovery.create({
  storage: api.storage.local,
  retry: async (job, { recoveryId }) => {
    if (job.items[0].kind !== "post") return downloadJob(job, recoveryId);
    const url = new URL(job.items[0].url);
    const tabs = await api.tabs.query({ url: `${url.origin}/*` });
    const source = job.sourceTab;
    const eligible = tabs.filter(tab => !source || (Boolean(tab.incognito) === source.incognito &&
      (source.cookieStoreId ? tab.cookieStoreId === source.cookieStoreId : typeof browser === "undefined" || tab.id === source.id)));
    const tab = eligible.find(item => item.id === source?.id) || eligible.find(item => item.active) || eligible[0];
    if (!tab?.id) throw new Error(source && !source.cookieStoreId && typeof browser !== "undefined"
      ? "The original Reddit tab is unavailable. Reopen the post and use Save media there."
      : "Open a Reddit tab in the original browser container, then retry this download.");
    return api.tabs.sendMessage(tab.id, { type: "retry-download-post", permalink: url.pathname, recoveryId }, { frameId: 0 });
  },
});
const DEFAULTS = { folder: "Reddit Media", bySubreddit: false };
const blobDownloads = new Map();
let pendingBlobDownloads = 0;
let offscreenCreation = null;
let muxJobs = 0;

function mediaModule() {
  if (!globalThis.RedditGrabMedia) throw new Error("Media helpers did not load");
  return globalThis.RedditGrabMedia;
}

function safeName(value, fallback = "reddit") {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 90);
  return cleaned || fallback;
}

function safeFolder(value) {
  return String(value || "")
    .split("/")
    .map((part) => safeName(part, ""))
    .filter(Boolean)
    .join("/");
}

function extensionFromUrl(url, fallback = "bin") {
  try {
    const match = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    return match ? match[1].toLowerCase() : fallback;
  } catch {
    return fallback;
  }
}

async function ensureOffscreenDocument() {
  if (!api.offscreen) return;
  const documentUrl = api.runtime.getURL("mux.html");
  const contexts = await api.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl],
  });
  if (contexts.length) return;

  if (!offscreenCreation) {
    offscreenCreation = api.offscreen
      .createDocument({
        url: "mux.html",
        reasons: ["WORKERS", "BLOBS"],
        justification: "Merge Reddit video and audio streams into one MP4",
      })
      .finally(() => {
        offscreenCreation = null;
      });
  }
  await offscreenCreation;
}

async function closeOffscreenWhenIdle() {
  if (!api.offscreen || muxJobs || pendingBlobDownloads || blobDownloads.size || offscreenCreation) return;
  try {
    await api.offscreen.closeDocument();
  } catch {
    // The document may already have been closed by the browser.
  }
}

async function recoverStaleOffscreen() {
  if (!api.offscreen || muxJobs || pendingBlobDownloads || blobDownloads.size || offscreenCreation) return;
  const activeDownloads = await api.downloads.search({ state: "in_progress" });
  const extensionBlobPrefix = `blob:${api.runtime.getURL("")}`;
  const activeBlobDownload = activeDownloads.some(
    (download) =>
      download.url?.startsWith(extensionBlobPrefix) || download.finalUrl?.startsWith(extensionBlobPrefix)
  );
  if (!activeBlobDownload) await closeOffscreenWhenIdle();
}

async function muxStreams(videoUrl, audioUrl) {
  muxJobs++;
  try {
    if (api.offscreen) {
      await ensureOffscreenDocument();
      const response = await api.runtime.sendMessage({
        target: "mux",
        type: "merge-streams",
        videoUrl,
        audioUrl,
      });
      if (!response?.ok) throw new Error(response?.error || "Video/audio merge failed");
      return response.blobUrl;
    }

    const { muxToBlobUrl } = await import("./mux-lib.js");
    return muxToBlobUrl(videoUrl, audioUrl);
  } finally {
    muxJobs--;
  }
}

async function releaseBlob(blobUrl) {
  if (api.offscreen) {
    await api.runtime
      .sendMessage({ target: "mux", type: "release-blob", blobUrl })
      .catch(() => undefined);
  } else {
    URL.revokeObjectURL(blobUrl);
  }
}

api.downloads.onChanged.addListener(async ({ id, state, error }) => {
  if (!state) return;
  if (state.current !== "complete" && state.current !== "interrupted") return;
  await recovery.changed({ id, state, error }).catch(() => undefined);
  if (!blobDownloads.has(id)) {
    await recoverStaleOffscreen();
    return;
  }
  const blobUrl = blobDownloads.get(id);
  blobDownloads.delete(id);
  await releaseBlob(blobUrl);
  await closeOffscreenWhenIdle();
});

function siblingMediaUrl(name, sourceUrl) {
  const source = new URL(sourceUrl);
  const result = new URL(name, new URL(".", source));
  if (!result.search && source.search) result.search = source.search;
  return result.href;
}

async function existingAudioFallback(sourceUrl) {
  for (const name of [
    "CMAF_AUDIO_128.mp4",
    "CMAF_AUDIO_64.mp4",
    "DASH_AUDIO_128.mp4",
    "DASH_AUDIO_64.mp4",
    "DASH_audio.mp4",
  ]) {
    const candidate = siblingMediaUrl(name, sourceUrl);
    try {
      const response = await fetch(candidate, { method: "HEAD" });
      if (response.ok) return candidate;
    } catch {
      // Try the next known Reddit audio filename.
    }
  }
  return null;
}

async function resolveRedditVideo(item) {
  const seedUrl = item.videoUrl || item.dashUrl;
  if (!seedUrl) throw new Error("Reddit returned no video stream");
  if (item.audio === "none" && item.videoUrl) {
    return { kind: "direct", url: item.videoUrl, suffix: item.suffix, ext: "mp4" };
  }

  const manifestUrl = item.dashUrl || siblingMediaUrl("DASHPlaylist.mpd", seedUrl);
  let videoUrl = item.videoUrl || null;
  let audioUrl = null;
  try {
    const response = await fetch(manifestUrl);
    if (response.ok) {
      const resolved = mediaModule().parseDashManifest(await response.text(), manifestUrl);
      videoUrl ||= resolved?.videoUrl || null;
      audioUrl = resolved?.audioUrl || null;
    }
  } catch {
    // Fall back to Reddit's known audio filenames below.
  }

  if (!videoUrl) throw new Error("Reddit's DASH manifest contained no video stream");
  if (item.audio === "none") {
    return { kind: "direct", url: videoUrl, suffix: item.suffix, ext: "mp4" };
  }
  if (!audioUrl) audioUrl = await existingAudioFallback(manifestUrl);
  if (!audioUrl) {
    if (item.audio === "required") throw new Error("Reddit reported audio, but no audio stream was found");
    return { kind: "direct", url: videoUrl, suffix: item.suffix, ext: "mp4" };
  }

  return {
    kind: "mux",
    videoUrl,
    audioUrl,
    suffix: item.suffix,
    ext: "mp4",
  };
}

async function resolveItem(item) {
  if (item.kind === "direct") return item;
  if (item.kind === "reddit-video") return resolveRedditVideo(item);
  const supplied = await globalThis.RedditGrabProviders?.resolve(item);
  if (supplied) return supplied;
  if (item.kind === "external" && item.provider === "giphy") {
    return { kind: "direct", url: `https://i.giphy.com/${item.id}.gif`, suffix: item.suffix, ext: "gif" };
  }
  if (item.kind === "external" && item.url) {
    return { kind: "direct", url: item.url, suffix: item.suffix, ext: item.ext };
  }
  throw new Error(`Unsupported media type: ${item.kind}`);
}

async function reconcileTransfer(id) {
  const [download] = await api.downloads.search({ id });
  if (!download || ["complete", "interrupted"].includes(download.state)) {
    await recovery.changed({ id, state: { current: download?.state || "interrupted" },
      error: { current: download?.error || "The browser no longer has this download. Check your files before retrying." } });
  }
}

async function recordDownloadFailure(job, item, error, recoveryId) {
  try { await recovery.recordFailure(job, item, error, recoveryId); }
  catch { console.warn("[Reddit Media Grab] could not save download recovery"); }
}

async function downloadJob(job, recoveryId) {
  const settings = await api.storage.sync.get(DEFAULTS);
  const folders = [];
  const configuredFolder = safeFolder(settings.folder);
  if (configuredFolder) folders.push(configuredFolder);
  if (settings.bySubreddit) folders.push(safeName(job.subreddit));
  const prefix = folders.length ? `${folders.join("/")}/` : "";
  const baseName = safeName(job.postId, "post");

  let saved = 0;
  let failed = 0;
  let separateAudio = 0;

  async function save(url, suffix = "", ext, sourceItem) {
    const filename = `${prefix}${baseName}${suffix}.${ext || extensionFromUrl(url, "bin")}`;
    const id = await api.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
    // A storage failure must not repeat a download already accepted by the browser.
    try {
      await recovery.recordStarted(id, job, sourceItem, recoveryId);
      await reconcileTransfer(id);
    } catch { console.warn("[Reddit Media Grab] could not track browser download"); }
    return id;
  }

  for (const sourceItem of job.items) {
    try {
      const item = await resolveItem(sourceItem);
      if (item.kind !== "mux") {
        await save(item.url, item.suffix, item.ext || item.extHint, sourceItem);
        saved++;
        continue;
      }

      let blobUrl = null;
      let muxFailure = null;
      let downloadAlreadyFinished = false;
      pendingBlobDownloads++;
      try {
        blobUrl = await muxStreams(item.videoUrl, item.audioUrl);
        const downloadId = await save(blobUrl, item.suffix, "mp4", sourceItem);
        blobDownloads.set(downloadId, blobUrl);
        const [download] = await api.downloads.search({ id: downloadId }).catch(() => []);
        if (download && download.state !== "in_progress" && blobDownloads.has(downloadId)) {
          blobDownloads.delete(downloadId);
          await releaseBlob(blobUrl);
          downloadAlreadyFinished = true;
        }
        saved++;
      } catch (error) {
        muxFailure = error;
        if (blobUrl) await releaseBlob(blobUrl);
      } finally {
        pendingBlobDownloads--;
        if (muxFailure || downloadAlreadyFinished) await closeOffscreenWhenIdle();
      }

      if (muxFailure) {
        console.warn("[Reddit Media Grab] merge failed; saving separate streams", muxFailure);
        let fallbackSaved = 0;
        for (const [url, suffix] of [
          [item.videoUrl, item.suffix],
          [item.audioUrl, `${item.suffix || ""}_audio`],
        ]) {
          const stream = { kind: "direct", url, suffix, ext: "mp4" };
          try {
            await save(url, suffix, "mp4", stream);
            saved++;
            fallbackSaved++;
          } catch (fallbackError) {
            failed++;
            await recordDownloadFailure(job, stream, fallbackError, recoveryId);
            console.warn("[Reddit Media Grab] separate stream failed", fallbackError);
          }
        }
        if (fallbackSaved === 2) separateAudio++;
      }
    } catch (error) {
      failed++;
      await recordDownloadFailure(job, sourceItem, error, recoveryId);
      console.warn("[Reddit Media Grab] media item failed", error);
    }
  }

  if (!saved) throw new Error(failed ? "Every media download failed. Check Failed downloads in extension settings." : "No downloadable media found");
  return { ok: true, saved, failed, separateAudio };
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (["recovery-list", "recovery-retry", "recovery-dismiss"].includes(message?.type)) {
    if (sender.id !== api.runtime.id || sender.url?.split(/[?#]/)[0] !== api.runtime.getURL("options.html")) {
      sendResponse({ ok: false, error: "Open extension settings to manage failed downloads." });
      return undefined;
    }
    (async () => {
      if (message.type === "recovery-list") return { ok: true, items: await recovery.list() };
      if (message.type === "recovery-retry") await recovery.retry(message.id);
      else await recovery.dismiss(message.id);
      return { ok: true };
    })().then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "download-failed-post") {
    if (sender.id !== api.runtime.id || !sender.tab?.id || !isRedditUrl(sender.url || sender.tab.url)) return undefined;
    const job = { ...message.job, sourceTab: { id: sender.tab.id, incognito: sender.tab.incognito === true,
      ...(sender.tab.cookieStoreId ? { cookieStoreId: sender.tab.cookieStoreId } : {}) } };
    recovery.recordFailure(job, job.items?.[0], message.error, message.recoveryId)
      .then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "reddit-grab-request") {
    try {
      const origin = new URL(sender.url || sender.tab?.url).origin;
      if (sender.id !== api.runtime.id || !sender.tab?.id || (sender.frameId || 0) !== 0 || origin !== message.request?.origin) {
        throw new Error("Only this extension's Reddit tab can schedule requests");
      }
      const scope = `${sender.tab.incognito ? "private" : "normal"}:${sender.tab.cookieStoreId ||
        (typeof browser !== "undefined" ? `tab-${sender.tab.id}` : "default")}`;
      requestBroker.enqueue(message.request, { tabId: sender.tab.id, scope })
        .then(value => sendResponse({ ok: true, value }), error => sendResponse({ ok: false, error: error.message }));
    } catch (error) { sendResponse({ ok: false, error: error.message }); }
    return true;
  }
  if (message?.type !== "download-media") return undefined;
  downloadJob(message.job, message.recoveryId)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

function isRedditUrl(value) {
  try {
    return /(^|\.)reddit\.com$/i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

async function injectContentScript(tabId) {
  await api.scripting.executeScript({
    target: { tabId },
    files: [...(globalThis.RedditGrabProviders ? ["local-provider.js"] : []), "reddit-media.js", "reddit-requests.js", "content.js", "reddit-feeds.js", "custom-feeds.js"],
  });
}

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading" || !isRedditUrl(tab.url)) return;
  injectContentScript(tabId).catch((error) => {
    console.warn("[Reddit Media Grab] automatic injection failed", error);
  });
});

api.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await api.tabs.sendMessage(tab.id, { type: "download-current-post" });
  } catch {
    try {
      await injectContentScript(tab.id);
      await api.tabs.sendMessage(tab.id, { type: "download-current-post" });
    } catch (error) {
      console.warn("[Reddit Media Grab] active-tab injection failed", error);
    }
  }
});

recoverStaleOffscreen().catch(() => undefined);
recovery.pending().then(ids => Promise.all(ids.map(id => reconcileTransfer(id).catch(() => undefined))))
  .catch(() => undefined);
api.tabs
  .query({ url: ["*://reddit.com/*", "*://*.reddit.com/*"] })
  .then((tabs) => Promise.all(tabs.filter((tab) => tab.id).map((tab) => injectContentScript(tab.id))))
  .catch((error) => console.warn("[Reddit Media Grab] existing-tab injection failed", error));
