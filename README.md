# Reddit Image Grab

Cross-browser extension (Manifest V3, Chrome + Firefox): hover any image or
gallery post on Reddit and a **⬇︎ Save images** button appears. One click
downloads every image in the carousel at full resolution — no scrolling
through the gallery, no per-image saving.

## Install

**Chrome**

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder

**Firefox** (115+)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and select `manifest.json` in this folder

Temporary add-ons are removed when Firefox restarts. To install permanently,
either sign it through addons.mozilla.org (unlisted self-distribution), or use
Firefox Developer Edition / Nightly with `xpinstall.signatures.required=false`
in `about:config` and install a zip of this folder via `about:addons`.

## Usage

- **Hover button** — hover a gallery/image post anywhere (feed or post page),
  click *Save images*. The button confirms with `✓ N saved`.
- **Toolbar icon** — while viewing a post page, click the extension icon to
  download that post's images.
- Works on new Reddit (`www.reddit.com`) and old Reddit (`old.reddit.com`).

## Folder setting

Right-click the extension icon → **Options**:

- **Save into folder** — subfolder inside your Downloads directory
  (default `PhotoVault Inbox`). Nest with `/`, e.g. `Reddit/wallpapers`.
- **Subfolder per subreddit** — off by default; when on:
  `.../pics/1abcde_01.jpg`.

`Downloads/PhotoVault Inbox` is a symlink to `~/PhotoVault Inbox`, so
downloads land in the real folder while the extension stays inside the
Downloads sandbox. Recreate it with:

```sh
ln -s "$HOME/PhotoVault Inbox" "$HOME/Downloads/PhotoVault Inbox"
```

> Browsers only let extensions write inside the Downloads folder. To land
> files elsewhere, change the browser's download location or symlink the
> target folder into Downloads.

## Cross-browser notes

- `manifest.json` declares both `background.service_worker` (Chrome ≥121) and
  `background.scripts` (Firefox event page); each browser uses its own key.
- All scripts use `const api = browser ?? chrome` and promise-style calls,
  which behave identically in Firefox (`browser`) and Chrome MV3 (`chrome`).
- `browser_specific_settings.gecko.id` is required by Firefox for
  `storage.sync`; Chrome ignores the key.

## Supported media

- **Image galleries** — every image at full resolution, `<postid>_01.jpg`, …
- **Single images** — i.redd.it originals.
- **Gifs** — v.redd.it "gifs", animated gallery items (`.gif`, falling back to
  `.mp4`), and imgur `.gifv` (saved as `.mp4`). Single file, since gifs carry
  no audio.
- **Videos (v.redd.it)** — Reddit streams video and audio as *separate* DASH
  files with no merged version, so the extension bundles ffmpeg.wasm (~31 MB)
  and merges them itself (lossless stream copy): one `<postid>.mp4` with
  sound. On Chrome the merge runs in an offscreen document; on Firefox in the
  background page. If merging ever fails, it falls back to saving the two
  streams separately (`<postid>.mp4` + `<postid>_audio.mp4`), mergeable with
  `ffmpeg -i v.mp4 -i a.mp4 -c copy out.mp4`.

- **Giphy** — page/embed links are rewritten to the direct
  `i.giphy.com/<id>.gif` original.

Not supported: hosts needing per-user auth or heavier APIs (YouTube,
streamable, Twitter/X embeds).

## How it works

Clicking the button fetches the post's own JSON
(`<permalink>.json?raw_json=1`, same-origin with your session). Galleries are
reconstructed from `gallery_data` + `media_metadata` as full-resolution
originals at `https://i.redd.it/<media_id>.<ext>`. Videos come from
`secure_media.reddit_video.fallback_url`; the audio track is found by reading
the post's DASH manifest and picking the highest-bitrate audio stream. Relative
audio paths are resolved from the manifest's full directory, including Reddit's
newer nested `v.redd.it/link/<post>/asset/<id>/...` layout. Crossposts resolve
to the original post. All downloads use conflict-safe uniquify naming.

Reddit rate-limits the JSON endpoint (~10 requests/min logged out, ~100
logged in). On a 429 the button shows a countdown and retries automatically,
honoring Reddit's `Retry-After` header (up to 3 attempts). Staying logged in
gives the higher limit.
