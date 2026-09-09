import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("background message contract downloads every direct gallery item with extension hints", async () => {
  const downloads = [];
  let messageListener;
  const context = {
    URL,
    console,
    fetch,
    globalThis: null,
    RedditGrabMedia: {
      parseDashManifest: () => ({ videoUrl: null, audioUrl: null }),
    },
    chrome: {
      action: { onClicked: { addListener() {} } },
      downloads: {
        onChanged: { addListener() {} },
        async download(options) {
          downloads.push(options);
          return downloads.length;
        },
      },
      runtime: {
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          },
        },
      },
      scripting: { executeScript: async () => undefined },
      storage: {
        sync: {
          async get(defaults) {
            return defaults;
          },
        },
      },
      tabs: {
        onUpdated: { addListener() {} },
        query: async () => [],
        sendMessage: async () => undefined,
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(await readFile("background.js", "utf8"), context);

  const response = await new Promise((resolve) => {
    const keepAlive = messageListener(
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
      },
      {},
      resolve
    );
    assert.equal(keepAlive, true);
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(response)),
    { ok: true, saved: 2, failed: 0, separateAudio: 0 }
  );
  assert.equal(downloads[0].filename, "Reddit Media/abc123_01.png");
  assert.equal(downloads[1].filename, "Reddit Media/abc123_02.jpg");
});
