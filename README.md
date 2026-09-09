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
- A **Save media** icon, last in the row, that loads the post's JSON and
  downloads all available media.

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

The floating button checks membership automatically. If the current profile or
community is already included, it turns green and shows **In 1 feed** or
**In 2 feeds**, with the feed names on hover. Open the picker to see the matching
feeds. While checking, or if Reddit cannot be reached, it shows an explicit
checking or unknown state. Opening the picker, returning to the tab, hovering
over the button, or switching profile tabs refreshes the membership check.
Feeds changed through the picker are read individually again so an older
aggregate feed listing cannot erase a verified addition from the indicator.

Post **Join** controls become **Add to feed** buttons. Click one to open the same
picker for that post's community without leaving the page. This works while
scrolling profiles, communities, and other post listings. After a verified add,
matching post buttons disappear. Communities already in your feeds have no
button. Reddit's **Joined** controls stay unchanged.

Membership loads automatically on custom-feed pages too, even though those pages
have no floating page button. Returning to the tab or changing the feed sort
refreshes it. Scrolling reuses that list without requests for individual posts. If a lookup fails, Add to feed remains available and the
picker checks membership again before adding. The floating button continues to
show membership for the profile or community page you are viewing.

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
- The menu does not exist until its dropdown is first opened — Reddit fetches
  it through `shreddit-async-loader`. Each post is therefore primed when it
  scrolls into view: the dropdown is opened behind an `opacity: 0` clamp, the
  items are taken, and it is closed again. Priming is queued one post at a
  time, because Reddit closes whichever dropdown is already open when another
  opens. A `MutationObserver` also adopts items whenever they appear on their
  own, and hovering a post primes it immediately.
- The injection point, not the post element, is what gets claimed. Reddit nests
  `article` and `shreddit-post`, so a post matches the post selector more than
  once and would otherwise get one row per wrapper.
- If no dropdown is found at all, only **Save media** is injected.

The **Save media** icon is the extension's own, built with `createElementNS`
rather than `innerHTML` so it still renders if Reddit enforces Trusted Types.

Media detection is based solely on the post JSON. DASH requests run
in the background extension context where the required host permissions are
declared; Reddit page telemetry and CORS errors do not affect them.

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
