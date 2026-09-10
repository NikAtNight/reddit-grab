import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

await import("../reddit-media.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  extractMedia,
  giphyId,
  parseDashManifest,
  redditJsonUrl,
} = globalThis.RedditGrabMedia;

async function fixture(name, parse = true) {
  const contents = await readFile(path.join(__dirname, "fixtures", name), "utf8");
  return parse ? JSON.parse(contents) : contents;
}

test("exports the same API in browser and CommonJS contexts", async () => {
  const source = await readFile(path.join(__dirname, "..", "reddit-media.js"), "utf8");
  const browserContext = { URL };
  vm.runInNewContext(source, browserContext);
  assert.equal(typeof browserContext.RedditGrabMedia.extractMedia, "function");

  const commonJsContext = { URL, module: { exports: {} } };
  vm.runInNewContext(source, commonJsContext);
  assert.equal(typeof commonJsContext.module.exports.extractMedia, "function");
  assert.equal(typeof commonJsContext.module.exports.parseDashManifest, "function");
});

test("builds the JSON endpoint on the active Reddit origin", () => {
  assert.equal(
    redditJsonUrl("https://www.reddit.com/r/pics/comments/abc/title/?utm_source=x", "https://old.reddit.com"),
    "https://old.reddit.com/r/pics/comments/abc/title.json?raw_json=1"
  );
});

test("preserves gallery order, skips invalid entries, and normalizes source URLs", async () => {
  const result = extractMedia(await fixture("gallery.json"));
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0], {
    kind: "direct",
    url: "https://preview.redd.it/second.png?width=4096&format=png",
    suffix: "_01",
    extHint: "png",
  });
  assert.deepEqual(result.items[1], {
    kind: "direct",
    url: "https://i.redd.it/first.jpg",
    suffix: "_02",
    extHint: "jpg",
  });
});

test("prefers MP4 for animated gallery items and falls back to GIF", async () => {
  const result = extractMedia(await fixture("animated-gallery.json"));
  assert.deepEqual(result.items.map(({ url, suffix, extHint }) => ({ url, suffix, extHint })), [
    { url: "https://preview.redd.it/both.mp4", suffix: "_01", extHint: "mp4" },
    { url: "https://preview.redd.it/only.gif", suffix: "_02", extHint: "gif" },
  ]);
});

test("extracts crosspost media while retaining the clicked post identity", async () => {
  const result = extractMedia(await fixture("crosspost.json"));
  assert.equal(result.postId, "clicked-post");
  assert.equal(result.subreddit, "reposts");
  assert.equal(result.sourcePostId, "original-post");
  assert.equal(result.sourceSubreddit, "wallpapers");
  assert.equal(result.items[0].url, "https://i.redd.it/original.webp?token=signed");
});

test("falls back to outer media and terminates cyclic crossposts", () => {
  const outer = { id: "outer", subreddit: "pics", url: "https://i.redd.it/outer.png" };
  const inner = { id: "inner", url: "https://example.com/not-media" };
  outer.crosspost_parent_list = [inner];
  inner.crosspost_parent_list = [outer];
  const result = extractMedia(outer);
  assert.equal(result.sourcePostId, "outer");
  assert.equal(result.items[0].url, "https://i.redd.it/outer.png");
});

test("describes Reddit video audio without dropping signed query parameters", async () => {
  const result = extractMedia(await fixture("video.json"));
  assert.deepEqual(result.items, [{
    kind: "reddit-video",
    videoUrl: "https://v.redd.it/link/post/asset/media/DASH_1080.mp4?source=fallback&token=signed",
    dashUrl: "https://v.redd.it/link/post/asset/media/DASHPlaylist.mpd?token=signed",
    audio: "required",
    suffix: "",
  }]);

  assert.equal(extractMedia({ preview: { reddit_video_preview: {
    fallback_url: "https://v.redd.it/a/DASH_720.mp4",
    is_gif: true,
  } } }).items[0].audio, "probe");
  assert.equal(extractMedia({ preview: { reddit_video_preview: {
    fallback_url: "https://v.redd.it/a/DASH_720.mp4",
    is_gif: true,
    has_audio: true,
  } } }).items[0].audio, "required");
  assert.equal(extractMedia({ media: { reddit_video: {
    fallback_url: "https://v.redd.it/a/DASH_720.mp4",
  } } }).items[0].audio, "probe");
});

test("recognizes external hosts, direct Giphy media, Imgur gifv, and preview fallback", async () => {
  const posts = await fixture("hosts.json");
  assert.equal(giphyId(posts.giphy.url), "AbC123");
  assert.equal(giphyId(posts.giphyEmbed.url), "XyZ987");

  assert.equal(extractMedia(posts.giphy).items[0].provider, "giphy");
  assert.equal(extractMedia(posts.giphyEmbed).items[0].id, "XyZ987");
  assert.equal(extractMedia(posts.giphyDirect).items[0].kind, "direct");
  assert.equal(extractMedia(posts.imgur).items[0].url, "https://i.imgur.com/motion.mp4?tag=reddit");
  assert.equal(extractMedia(posts.preview).items[0].url, "https://preview.redd.it/fallback.jpg?a=1&b=2");
});

test("selects the highest-bandwidth DASH video and audio using relative BaseURLs", async () => {
  const manifest = await fixture("reddit-dash.mpd", false);
  assert.deepEqual(
    parseDashManifest(manifest, "https://v.redd.it/link/post/media/DASHPlaylist.mpd?auth=manifest"),
    {
      videoUrl: "https://v.redd.it/link/post/media/streams/DASH_1080.mp4?token=video-high&x=1",
      audioUrl: "https://v.redd.it/link/post/media/streams/audio/CMAF_AUDIO_128.mp4?token=audio-high&x=1",
    }
  );
});

test("returns null for a missing DASH media type", () => {
  const manifest = `
    <MPD><Period><AdaptationSet mimeType="video/mp4">
      <Representation bandwidth="100"><BaseURL>video.mp4</BaseURL></Representation>
    </AdaptationSet></Period></MPD>`;
  assert.deepEqual(parseDashManifest(manifest, "https://v.redd.it/id/manifest.mpd"), {
    videoUrl: "https://v.redd.it/id/video.mp4",
    audioUrl: null,
  });
});

test("inherits a signed manifest query for relative DASH streams", () => {
  const manifest = `<MPD><Period>
    <AdaptationSet mimeType="video/mp4"><Representation bandwidth="10"><BaseURL>video.mp4</BaseURL></Representation></AdaptationSet>
    <AdaptationSet mimeType="audio/mp4"><Representation bandwidth="10"><BaseURL>audio.mp4</BaseURL></Representation></AdaptationSet>
  </Period></MPD>`;
  assert.deepEqual(parseDashManifest(manifest, "https://v.redd.it/id/manifest.mpd?token=signed"), {
    videoUrl: "https://v.redd.it/id/video.mp4?token=signed",
    audioUrl: "https://v.redd.it/id/audio.mp4?token=signed",
  });
});

test("optional providers can select original media before a derived preview", async () => {
  const context = { URL, RedditGrabProviders: { extract: url => url === "https://provider.example/watch/fixture"
    ? [{ kind: "external", provider: "fixture", id: "sample", suffix: "" }] : null } };
  vm.runInNewContext(await readFile("reddit-media.js", "utf8"), context);
  const result = context.RedditGrabMedia.extractMedia({ id: "fixture",
    url: "https://provider.example/watch/fixture",
    preview: { reddit_video_preview: { fallback_url: "https://v.redd.it/preview.mp4", has_audio: false } },
  });
  assert.equal(result.items[0].provider, "fixture");
  assert.equal(context.RedditGrabMedia.extractMedia({ id: "image", url: "https://i.redd.it/image.jpg" }).items[0].kind, "direct");
});
