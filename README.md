# Reddit Media Grab

A Chrome and Zen/Firefox extension that pulls each Reddit post's overflow menu
actions out into one-click icons in the post header, and adds a **Save media**
icon alongside them. It downloads full image carousels and saves Reddit videos
as a single MP4 with audio.

## Build

Requires Node.js 22 or newer.

```sh
npm ci
npm run build
```

This creates two intentionally separate browser packages:

- `dist/chrome` — Chrome Manifest V3 service worker and offscreen muxer.
- `dist/firefox` — Zen/Firefox Manifest V3 background document, with no
  Chrome-only permissions.

There is deliberately no root `manifest.json`. Always load the package for
your browser so Zen never sees Chrome's `offscreen` permission.

## Install

### Zen or Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Remove any older Reddit Image/Media Grab temporary add-on.
3. Click **Load Temporary Add-on…**.
4. Select `dist/firefox/manifest.json`.
5. Refresh any Reddit tabs that were already open.

### Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `dist/chrome`.
4. Refresh any Reddit tabs that were already open.

## Use

Every post gains a row of icons in its action bar, just after **Share**:

- One icon per item from that post's overflow menu — normally Follow post,
  Award, Save, Hide, and Report.
- A **Save media** icon, last in the row, that downloads available media.
  Direct images use the post's canonical image URL when available.

Those are not copies. The extension **moves** Reddit's own `<li>` nodes out of
the menu and into the action bar, then hides everything inside them except the
icon. Each one keeps the handlers, state, and analytics Reddit attached to it,
so clicking it in the action bar is the same event as clicking it in the menu.
Nothing is simulated, and the extension does not need to know how Reddit wired
those handlers up.

Once the items have moved, the menu is empty and the `···` button is hidden. If
a post's menu never renders, `···` stays put rather than leaving its actions
unreachable.

The toolbar icon also downloads media when the current tab is an individual
Reddit post.

Old Reddit has no overflow dropdown, so only the **Save media** icon is added
there, at the end of the post's existing action list.

Downloads go to `Downloads/Reddit Media` by default. Open the extension's
options to change the subfolder or add one folder per subreddit.

### Add profiles and communities to custom feeds

On a community or user profile page, click **Add to feed** in the bottom-right
corner. Search your existing custom feeds, then click the feed you want to add
the current profile or community to. This also works on profile tabs such as
Submitted and Comments, and community listings such as New and Top.

The floating button checks saved membership. If the current profile or community
is included, it turns green and shows **In 1 feed** or **In 2 feeds**, with the
feed names on hover. Open the picker to see the matching feeds. Its status line
shows the saved account, last full sync, and last local update.

Post **Join** controls become **Add to feed** buttons. Click one to open the same
picker for that post's community without leaving the page. After a verified add,
matching post buttons disappear. Communities and profiles already in your feeds
have no button. Reddit's **Joined** and **Following** controls stay unchanged.

Saved feed lists do not expire automatically. Scrolling, changing pages, returning
to a tab, and hovering make no feed API requests. The first explicit picker open
checks the account and loads feeds if none are saved. Later opens in the same tab
reuse the saved list. A new tab checks the account once when you open its picker.

Use **Reload feeds** after changing feeds elsewhere or switching accounts. Until
then, indicators reflect the named account's saved list. Each feed's saved member
names supply its count and capacity check. A confirmed add updates that feed and
other open tabs immediately. There is no separate count request or whole-list
reload after an add. Adds still check the live account and verify the destination
membership with one readback. Uncertain writes are checked before another attempt.
No passwords or Reddit session tokens are saved. Migration JSON files stay separate.

The picker shows queued requests and a cooldown countdown. During a cooldown or
while offline, saved membership remains available and network actions are disabled.
A failed sync can show saved data with a warning. Authentication failures require
signing in again. Use the extension's settings to retry failed downloads explicitly.

The picker shows each feed's privacy, member count, and whether the current
profile or community is already included. Full feeds and existing memberships
are disabled. Success appears after Reddit confirms the membership. If a request
is interrupted, another attempt checks membership before sending an add.

Sign in to Reddit in the same browser to use the picker. It uses that session;
no developer app or API key is needed. It adds to existing feeds and preserves
their settings. It does not join, leave, follow, or unfollow anything. Profiles
contribute posts made directly to the profile, not all of the user's posts in
other communities.

After updating, reload the extension from your browser's extension manager and
refresh existing Reddit tabs. Build and load the browser-specific package as
described above. In the source checkout, the flow and verification record is
[docs/flows/custom-feeds.md](docs/flows/custom-feeds.md).

## Supported media

- Image galleries in Reddit's declared carousel order, using full-size source
  URLs and stable names such as `<post-id>_01.jpg`.
- Single JPEG, PNG, WebP, AVIF, and GIF images.
- Animated gallery items, preferring MP4 when Reddit provides one.
- Reddit-hosted `v.redd.it` videos. The extension reads the DASH manifest,
  selects the highest-bandwidth audio stream, and uses the packaged
  ffmpeg.wasm runtime to losslessly combine video and audio into one MP4.
- Newer nested Reddit media paths such as
  `v.redd.it/link/<post>/asset/<id>/...`.
- Giphy and Imgur GIF/video links.
- Crossposts, using the original post's media while naming files from the post
  that was clicked.

A literal `.gif` file cannot contain audio. When Reddit presents a
"GIF" as an MP4 and an audio stream exists, the extension saves an MP4 with
audio. If ffmpeg cannot merge a Reddit video, it saves the video and audio as
two clearly named files instead of silently dropping the audio.

## How it avoids Reddit UI breakage

Post discovery is based on a comments permalink, not Reddit's changing media
markup or `post-type` attributes. The content script supports `shreddit-post`,
`article`, `[data-testid="post-container"]`, and old Reddit `.thing` elements.

Relocating the overflow menu is the one part that must touch Reddit's markup. It
degrades in steps rather than breaking:

- Moving the real nodes is what makes this robust. Anything that reimplemented
  the actions, or synthesised clicks against them, would depend on how Reddit
  binds its handlers — which is a lit implementation detail and not something
  the extension can see. A moved node needs no such knowledge.
- A post header holds several `rpl-dropdown` elements (author and community
  cards use them too), so the overflow menu is identified by what it contains,
  not by document order: `li[id^="post-overflow-"]` first, then the
  `shreddit-post-overflow-menu` tag, then the `overflow-horizontal` icon in its
  trigger. The icon matters because the menu is rendered lazily and is often
  not there to identify on the first pass. Each of those is positive evidence;
  if none of them matches, nothing is injected, because falling back to a plain
  dropdown parks a stray row beside the author or community card.
- The trigger is found by `aria-haspopup="menu"` first, since Reddit's `···`
  button carries no `slot="trigger"` attribute.
- A post is skipped if it already contains a row. Claiming the dropdown alone
  is not enough: moving the items empties the menu, after which the second
  wrapper no longer recognises that dropdown and would settle on a neighbouring
  one and inject a second row.
- The row goes in the action bar (`rpl-action-bar`, else whatever row holds the
  share button), not next to the `···` it came from. The credit bar cannot hold
  it: Reddit boxes the `···` in wrappers sized to exactly one icon
  (`shreddit-async-loader` is `w-xl h-xl`), and even clear of those the bar runs
  out of width on a narrow card. The action bar is a plain flex line with free
  space to its right. Posts with no action bar fall back to the credit bar,
  climbing out of the one-icon wrappers first.
- The row is positioned. Reddit covers each card with
  `a[slot="full-post-link"].absolute.inset-0`, which paints over static content
  and turns any click into "open the post". Reddit's own controls escape it by
  being positioned, so the row does the same instead of trying to swallow the
  click.
- The row is rebuilt if it goes missing. Reddit re-renders parts of a post, and
  marking the dropdown as claimed would suppress the row permanently once that
  happened. The presence of the row in the post is the only guard.
- Adoption keeps running rather than stopping at the first success, so items
  Reddit re-renders are not stranded back inside the dropdown.
- Only the icon is kept. Rather than matching Reddit's utility classes, every
  element inside a moved item that does not contain an `svg` is hidden, so the
  rule holds however the item is structured.
- `faceplate-tracker` wrappers are moved along with the item they wrap, so
  Reddit's own analytics stay attached.
- Reddit loads overflow menus on demand. Scrolling and hovering the whole post
  no longer open them. Hover or focus the action row briefly to load its icons.
  The native overflow remains available until extraction. Menu loading pauses
  while the extension's shared Reddit API cooldown is active.
- The injection point, not the post element, is what gets claimed. Reddit nests
  `article` and `shreddit-post`, so a post matches the post selector more than
  once and would otherwise get one row per wrapper.
- If no dropdown is found at all, only **Save media** is injected.

The **Save media** icon is the extension's own, built with `createElementNS`
rather than `innerHTML` so it still renders if Reddit enforces Trusted Types.

Direct image downloads use the matching rendered post's canonical image URL
when it unambiguously identifies an image. Other media uses post JSON, cached
for up to 100 posts per tab with concurrent requests shared. A 429 stops requests
without retries and records Reddit's cooldown headers. Images with known direct
URLs and previously cached post jobs can still download during that API cooldown.
Galleries or videos needing uncached JSON must wait; thumbnails are not used as
substitutes for complete galleries. Media hosts can impose their own limits.

Feed requests and post-JSON downloads share one queue across extension tabs. It
runs one request at a time, spaces starts by at least 1.5 seconds, and combines
concurrent matching reads within the same browser session. Requests still execute
in their originating Reddit tab. A 429 or exhausted quota header pauses queued
requests using Reddit's cooldown headers. Requests do not retry automatically.

Typical Reddit API request counts:

| Action | Requests |
| --- | --- |
| Browse, scroll, hover the feed picker, or update a cached count | 0 |
| First picker load with no saved feeds | 2: account and feed list |
| Open saved feeds in a new tab | 1: account check |
| Reopen saved feeds in that tab | 0 |
| Add to a known feed | 3: account check, member PUT, verification GET |
| Reload feeds | 2, plus a read for each changed or uncertain feed needing reconciliation |
| Download a canonical image or cached post job | 0 Reddit API requests |
| Download an uncached gallery or other post needing JSON | 1 |

Loading Reddit's native overflow menu after action-row hover can still cause
Reddit-owned requests outside this queue. The extension pauses menu loading during
a known cooldown. Reddit's own page activity, other extensions, and other devices
also remain outside this queue, so pacing cannot guarantee that 429s never occur.
DASH manifests, audio probes, and media transfers use their media
hosts separately. They do not wait behind the Reddit JSON queue.

### Retry failed downloads

Open extension settings and use **Failed downloads**. The latest 100 failures are
saved locally with **Retry** and **Dismiss** controls. Retry downloads only the
failed item, so it does not repeat successful gallery files or video fallback
streams. Browser transfers stay tracked until completion; interrupted transfers
return to the list. Nothing retries automatically when a cooldown ends.

If post JSON failed before media extraction, retry needs a Reddit tab in the
original browser container. Recovery keeps media source URLs, including required
signed query strings, in local extension storage. It does not keep request headers,
cookies, or Reddit modhashes. The list displays post identifiers and errors without
exposing the raw URLs. Expired media links may require opening the post again.

## Development

```sh
npm test             # extraction, DASH, UI, and manifest/build tests
npm run build        # generate both browser packages
npm run lint:firefox # build and validate the Zen/Firefox package
npm run check        # tests plus Firefox package validation
```

The custom-feed client checks run with `node --test test/reddit-feeds.test.js`.
For browser UI checks, serve the repository locally with
`python3 -m http.server 8765 --bind 127.0.0.1`, then open
`http://127.0.0.1:8765/test/fixtures/custom-feeds-ui.html`. This fixture uses
synthetic accounts and intercepts every API request; it does not contact Reddit.
The page reports its results directly.

The build copies a strict allowlist of source files plus `icons/` and `vendor/`
into each package. Browser-specific manifests live under `manifests/`.
