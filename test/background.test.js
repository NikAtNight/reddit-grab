import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadBackground({ download, state = {}, tabMessage, tabs = [] } = {}) {
  const downloads = [];
  let messageListener;
  let changed;
  const transfers = new Map();
  const context = {
    URL,
    URLSearchParams,
    setTimeout,
    structuredClone,
    console: { ...console, warn() {} },
    fetch,
    globalThis: null,
    RedditGrabMedia: {
      parseDashManifest: () => ({ videoUrl: null, audioUrl: null }),
    },
    chrome: {
      action: { onClicked: { addListener() {} } },
      downloads: {
        onChanged: { addListener(listener) { changed = listener; } },
        async download(options) {
          downloads.push(options);
          if (download) await download(options);
          const id = downloads.length;
          transfers.set(id, { id, state: "in_progress" });
          return id;
        },
        async search({ id }) { return transfers.has(id) ? [transfers.get(id)] : []; },
      },
      runtime: {
        id: "extension",
        getURL: path => `chrome-extension://extension/${path}`,
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          },
        },
      },
      scripting: { executeScript: async () => undefined },
      storage: {
        local: {
          async get(key) { return { [key]: structuredClone(state[key]) }; },
          async set(values) { Object.assign(state, structuredClone(values)); },
        },
        sync: {
          async get(defaults) {
            return defaults;
          },
        },
      },
      tabs: {
        onUpdated: { addListener() {} },
        query: async () => tabs,
        sendMessage: tabMessage || (async () => undefined),
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(await readFile("reddit-requests.js", "utf8"), context);
  vm.runInNewContext(await readFile("download-recovery.js", "utf8"), context);
  vm.runInNewContext(await readFile("background.js", "utf8"), context);
  const optionsSender = { id: "extension", url: "chrome-extension://extension/options.html" };
  return { downloads, state, transfers, changed: event => changed(event),
    message: (message, sender = optionsSender) => new Promise(resolve => messageListener(message, sender, resolve)) };
}

test("background message contract downloads every direct gallery item with extension hints", async () => {
  const { downloads, message } = await loadBackground();
  const response = await message(
      {
        type: "download-media",
        job: {
          postId: "abc123",
          subreddit: "pics",
          items: [
            { kind: "direct", url: "https://preview.redd.it/a?token=1", suffix: "_01", extHint: "png" },
            { kind: "direct", url: "https://i.redd.it/b.jpg", suffix: "_02", extHint: "jpg" },
          ],
        },
      });

  assert.deepEqual(
    JSON.parse(JSON.stringify(response)),
    { ok: true, saved: 2, failed: 0, separateAudio: 0 }
  );
  assert.equal(downloads[0].filename, "Reddit Media/abc123_01.png");
  assert.equal(downloads[1].filename, "Reddit Media/abc123_02.jpg");
});

const gallery = { postId: "example", subreddit: "pics", items: [
  { kind: "direct", url: "https://i.redd.it/success.jpg", suffix: "_01" },
  { kind: "direct", url: "https://i.redd.it/failed.jpg", suffix: "_02" },
] };

test("recovery retries only the failed gallery item and waits for browser completion", async () => {
  let fail = true;
  const { downloads, message, changed } = await loadBackground({ download: async ({ url }) => {
    if (url.endsWith("failed.jpg") && fail) throw new Error("Network failed");
  } });
  const initial = await message({ type: "download-media", job: gallery });
  assert.equal(initial.saved, 1);
  assert.equal(initial.failed, 1);
  const { items } = await message({ type: "recovery-list" });
  assert.equal(items.length, 1);
  assert.equal(items[0].job.items[0].url, gallery.items[1].url);
  fail = false;
  assert.equal((await message({ type: "recovery-retry", id: items[0].id })).ok, true);
  assert.equal(downloads.length, 3);
  assert.equal(downloads[2].url, gallery.items[1].url);
  assert.equal((await message({ type: "recovery-list" })).items[0].status, "downloading");
  await changed({ id: 3, state: { current: "complete" } });
  assert.equal((await message({ type: "recovery-list" })).items.length, 0);
});

test("browser interruption persists a failure and no automatic retry is issued", async () => {
  const { downloads, message, changed } = await loadBackground();
  await message({ type: "download-media", job: { ...gallery, items: [gallery.items[0]] } });
  await changed({ id: 1, state: { current: "interrupted" }, error: { current: "NETWORK_FAILED" } });
  const { items } = await message({ type: "recovery-list" });
  assert.equal(items.length, 1);
  assert.equal(items[0].error, "NETWORK_FAILED");
  assert.equal(downloads.length, 1);
});

test("post JSON recovery relays only an explicit retry into an open Reddit tab", async () => {
  const calls = [];
  const { message } = await loadBackground({ tabs: [{ id: 7, active: true, cookieStoreId: "other" }, { id: 8, cookieStoreId: "original" }], tabMessage: async (...args) => {
    calls.push(args); return { ok: false, error: "Reddit rate limit reached" };
  } });
  const sender = { id: "extension", url: "https://www.reddit.com/r/pics/", tab: { id: 8, cookieStoreId: "original" } };
  const recorded = await message({ type: "download-failed-post", job: { ...gallery, items: [
    { kind: "post", url: "https://www.reddit.com/r/pics/comments/example/title/" },
  ] }, error: "Rate limited" }, sender);
  assert.equal(recorded.ok, true);
  assert.equal(calls.length, 0);
  const { items } = await message({ type: "recovery-list" });
  assert.equal((await message({ type: "recovery-retry", id: items[0].id })).ok, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 8);
  assert.equal(calls[0][1].type, "retry-download-post");
  assert.equal(calls[0][1].recoveryId, items[0].id);
  assert.equal((await message({ type: "recovery-list" })).items[0].status, "failed");
});

test("settings recovery controls reject Reddit content tabs", async () => {
  const { message } = await loadBackground();
  const result = await message({ type: "recovery-list" }, { id: "extension", url: "https://www.reddit.com/", tab: { id: 1 } });
  assert.equal(result.ok, false);
});

test("background queue relays to the requesting main-frame tab and rejects other origins", async () => {
  const calls = [];
  const { message } = await loadBackground({ tabMessage: async (...args) => {
    calls.push(args); return { ok: true, value: { status: 200, headers: {}, body: "{}" } };
  } });
  const sender = { id: "extension", tab: { id: 12 }, frameId: 0, url: "https://www.reddit.com/" };
  const request = { origin: "https://www.reddit.com", path: "/api/me.json" };
  assert.equal((await message({ type: "reddit-grab-request", request }, sender)).ok, true);
  assert.equal(calls[0][0], 12);
  assert.equal(calls[0][1].type, "reddit-grab-execute-request");
  assert.equal(calls[0][2].frameId, 0);
  for (const invalid of [{ ...sender, frameId: 1 }, { ...sender, url: "https://old.reddit.com/" }, { ...sender, id: "other" }]) {
    assert.equal((await message({ type: "reddit-grab-request", request }, invalid)).ok, false);
  }
  assert.equal(calls.length, 1);
});
