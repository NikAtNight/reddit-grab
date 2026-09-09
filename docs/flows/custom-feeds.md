# Add to custom feeds

## Requirement and ownership

Owner: Reddit Media Grab maintainer. Source: user's September 9, 2026 request
for bottom-right quick-add controls on Reddit profiles and communities.
The picker adds the page target or a post's community to an existing, explicitly
selected feed. The user's follow-up requests replacing post Join with Add to feed.
Feed creation, automatic feed selection, subscription changes, and history
clearing are outside this flow.

## Path and contracts

Both browser manifests and `background.js:injectContentScript` load
`reddit-feeds.js` before `custom-feeds.js`. The build allowlist includes both.
`RedditGrabFeeds` is the shared client and route parser for profile and community
targets. `custom-feeds.js` owns the floating shadow-root UI and its state.

`targetFromUrl` recognizes community listings and profile tabs, including `/u/`
aliases. Post pages, aggregate feeds, settings, and custom-feed pages do not
display a launcher until an inline post button opens the picker. Reinjection is guarded. A 500 ms URL check and `popstate`
listener reset the picker on navigation and restore it if Reddit removes its host.

On a URL change, a 350 ms debounce starts a read-only membership check, even
when there is no profile or community target. This covers custom-feed pages,
including sort tabs, and other post listings. The
launcher shows a green feed count and matching names in its tooltip, or an
explicit checking/unknown state. `loadMembership` shares an in-flight request
between the automatic check and picker opening. There is no periodic API polling
or persistent membership cache; reopening refreshes the snapshot. Focus,
visibility, hover, and same-target URL changes also refresh through the debounced
lookup. Background refreshes are suppressed while hidden, loading, or writing.

The membership check loads the signed-in account and lists editable feeds. If
a profile or community target is supplied, it also resolves that target. A
lookup without a target skips `/api/info.json` and still populates post membership. Requests use same-origin
credentials. The session modhash stays in memory, is reacquired before a write,
and is never stored or rendered. A changed account requires reopening the picker.

`createClient.add` reads the chosen feed again. Existing membership is a no-op;
full feeds and lost edit access prevent a write. A single-member PUT preserves
other entries and feed settings. A separate GET must confirm membership before
the UI reports success. Requests never call subscription endpoints.

`pickerTarget` and `pickerOpener` track the selected community and focus return
independently of the page target. `updatePostJoins` replaces modern Reddit post
Join controls with Add to feed buttons. It preserves named slots and positions
buttons above the full-post link overlay. Inline `display: none !important`
backs the hidden flag because Reddit's button CSS overrides the native hidden
rule. A hidden flag alone left member buttons visible but ignored their clicks. A document capture listener handles inline clicks before post handlers, including
clicks on redrawn buttons that lost their original listener. `postCommunity` is
shared by rendering and click handling so recycled posts use their current
community. Redrawn duplicates are removed. A click stops post navigation and opens
the existing picker for the post's subreddit, including on home or post pages.
Joined controls stay native. The page launcher still reflects the page target.

`updateFeedNames` builds a case-insensitive set from the current lookup and
verified additions. Matching post buttons disappear after verification. Failed
lookups show Add to feed again; the picker always checks before writing. Post
scans include open shadow roots and stop at nested post boundaries. DOM mutations
trigger updates; a two second scan catches shadow roots attached without a
mutation. Recycled posts update their button targets. Removed or ineligible
controls regain their original display. There are no per-post background requests
or subscription changes.

Navigation is synchronized before choosing a launcher target or accepting a feed
selection, including changes occurring before the URL poll. Each add also checks
the picker generation, target, and URL before writing. Changing post selection
cancels an add still in its read phase; an already-sent write finishes for the
captured community and the new picker refreshes afterward.

## Failures and recovery

The UI blocks repeated clicks during an add. A generation check prevents a
stale selection from writing after navigation or dismissal. Once a write has
started, it finishes against its captured target. A reopened picker refreshes
after that operation settles.
An add also invalidates any lookup started before its result, so a delayed old
response cannot replace verified membership on the launcher or reopened picker.
The client remembers paths it has verified during this tab's lifetime. Subsequent
listings re-read those owned feeds individually. This prevents an outdated
aggregate listing from erasing confirmed membership, while still recognizing a
removal confirmed by the per-feed endpoint. No cached membership overrides live
per-feed data. The user's installed-extension symptom remains unconfirmed; this
disagreement was reproduced using controlled responses.

No request is retried automatically. HTTP 429 sets an in-memory cooldown using
Retry-After or rate-limit reset headers, with a minimum of one minute. Login,
access, unavailable targets, and malformed responses produce visible errors.
A lost write response or failed verification reports an uncertain outcome;
another click first checks live membership, avoiding a repeated completed add.

## Verification

Base commit: `c6e7740e4e99823266126868494e221ce194c7b4`, with uncommitted feature
changes. Existing unrelated changes were present before this task. Local patch
evidence for the picker: `/tmp/reddit-grab-custom-feeds.patch`. Join feature
source patch: `/tmp/reddit-grab-join-feature.patch`. Inline picker delta:
`/tmp/reddit-grab-inline-feature.patch`. Custom-feed page fix:
`/tmp/reddit-grab-feed-page.patch`. Visibility fix:
`/tmp/reddit-grab-hidden.patch`. Inline click handling delta:
`/tmp/reddit-grab-click.patch`.

- PASS: baseline `npm test`, 33 tests.
- PASS: `npm run check`, 47 tests, Chrome and Firefox builds, Firefox validation
  with zero errors, warnings, or notices. Node 22.23.2, npm 10.9.8, macOS.
- PASS: `test/reddit-feeds.test.js` covers profile resolution, community routes,
  account and edit-access guards, duplicates, capacity, stale navigation,
  membership readback, interrupted writes, login failure, and rate limiting.
- PASS: `test/manifests.test.js` verifies script ordering and packaged contents.
- PASS: regression first failed on an aggregate listing omitting a verified add;
  after the fix, it also confirms that actual removals remain visible.
- PASS: `test/fixtures/custom-feeds-ui.html`, 56 real-browser fixture checks:
  positioning, labels, focus, search, disabled full/added feeds, repeated clicks,
  navigation, reopen during a pending write, reinjection, and unsupported pages.
  Membership checks cover existing profiles and communities before opening,
  feed counts and names, navigation reset, verified-add updates, unavailable
  lookup state, and a delayed pre-write response arriving after verification.
  Additional checks cover stale aggregate listings, focus and hover refreshes,
  and changing tabs within the same profile. Join checks cover scrolling, shadow
  roots, case-insensitive membership, nested/recycled posts, removal, lookup
  failure, and immediate hiding after a verified picker addition. Inline picker
  checks cover post target selection, overlay hit testing, slots, focus return,
  profile badge isolation, duplicate clicks, pre-write target switching, Joined
  controls, home-page use, and navigation before the URL poll. Custom-feed checks
  cover automatic lookup, scrolling without extra requests, focus refresh, and
  sort navigation while keeping the floating page launcher hidden. Visibility
  checks use Reddit-like button CSS and assert computed display and zero width
  for existing members and verified additions. This regression failed before
  the fix. The same CSS conflict was reproduced on a live Reddit page: hidden
  was true but computed display was inline-block; the fix produced none and
  zero width. This does not establish installed Firefox execution. Click checks cover an
  intercepting ancestor capture handler and a cloned button on a recycled post.
  The original inline click worked on a real profile in the separate browser
  session; the user's exact Zen click failure has not been reproduced.
  The browser tool could not reach the local server, so the same fixture scripts
  were injected into an isolated test tab with synthetic API responses and a
  blob URL for reinjection. Evidence:
  `/tmp/reddit-grab-click-browser-check.json`. Build and automated-check log:
  `/tmp/reddit-grab-click-check.log`.
- PASS: injected UI on a real Reddit community page positioned correctly and
  displayed the sign-in message for the logged-out browser session.
- NOT RUN: authenticated writes through the newly packaged extension and
  installed Chrome/Firefox content-script isolation. The user must reload the
  built extension and sign in to exercise that final boundary. Prior migration
  operations confirmed the underlying Reddit endpoints, not this packaged UI.

Run the browser fixture using the local-server instructions in `README.md`.
Fixture results are displayed on the page and in `window.browserCheckResult`.
