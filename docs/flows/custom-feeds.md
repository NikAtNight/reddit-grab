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
between the automatic check and picker opening. `createClient` uses an optional
extension `storage.local` adapter, with memory fallback. Snapshots contain the account name and feed memberships, never the modhash.
Automatic URL/focus/hover lookups pass `cachedOnly: true`: no network requests,
even for expired/missing data or an active cooldown. Missing cache asks the user
to open the picker; tooltip labels identify the saved owner. Explicit picker opens
check the account once per page and keep saved snapshots until manual sync.
Reload feeds explicitly bypasses the snapshot. Account changes are not detected
by passive indicators until an explicit open or reload.
There is no periodic API polling. Verified per-feed updates use separate storage
keys so writes to different feeds in other tabs do not overwrite each other.
Snapshots are dated at request start and reconcile later verified overrides.
Cooldowns persist across tabs. An account switch in an already-open tab requires
Reload feeds; every add independently verifies the live account before writing.

An uncached explicit membership check loads the signed-in account and lists
editable feeds. There is no per-target `/api/info.json` lookup. Requests use
same-origin credentials through the shared background queue. The session modhash stays in memory, is reacquired before a write,
and is never stored or rendered. A changed account requires reopening the picker.

`createClient.add` uses the saved chosen feed, reading it first only when missing
or when a persisted uncertain write needs reconciliation. Existing membership
is a no-op; full feeds and lost edit access prevent a write. A single-member PUT preserves
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
manual listings re-read those owned feeds only when the aggregate membership
differs or a write checkpoint needs reconciliation. This prevents an outdated
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

## Profile posts in custom feeds

The follow-up reports Join controls on profile posts already in custom feeds.
`postCommunity` now accepts `u_` names with username hyphens and up to 20 username
characters, and normalizes `u/name` to `u_name`. The inline picker labels these
as profiles and retains the internal community name for membership and writes.

PASS: `npm run check`, 47 automated tests, both builds, zero Firefox validation
errors or warnings. PASS: 60 browser fixture checks, including profile membership,
prefixed names, maximum-length usernames, and button removal after a verified
profile add. Evidence: `/tmp/reddit-grab-profile-post-check.log` and
`/tmp/reddit-grab-profile-post-browser-check.json`. Base: `7e171cf`; uncommitted
patch: `/tmp/reddit-grab-profile-post.patch`. Installed Zen validation remains
NOT RUN. This change is local and has not been committed or pushed.

The next screenshot showed Follow rather than Join. Profile-post controls now
also recognize `follow-button` and follow-specific button selectors, restricted
to posts whose community is a profile. Following/Unfollow controls remain native.
PASS: 64 browser fixture checks, including native Follow replacement, hiding for
existing members, verified additions, and preserving controls outside posts.
PASS: `npm run check`, 47 tests and Firefox validation. Evidence:
`/tmp/reddit-grab-follow-check.log`, `/tmp/reddit-grab-follow-browser-check.json`,
and `/tmp/reddit-grab-follow.patch`. The separate live browser confirmed the
reported profile uses `u_` post attributes, but its post Follow control was not
rendered there. Installed Zen verification remains NOT RUN.

## Persistent membership cache verification

PASS: `npm run check`, 53 tests and Firefox validation. PASS: 67 browser fixture
checks. Prior live-response scenarios explicitly force refresh; cache scenarios
verify navigation, focus, hover, reopening, and manual Reload behavior. Client
tests cover cross-tab persistence, verified additions, expiry, concurrent opens,
account mismatch, shared cooldowns, and delayed aggregate responses. Evidence:
`/tmp/reddit-grab-cache-check.log`, `/tmp/reddit-grab-cache-browser-check.json`,
`/tmp/reddit-grab-cache.patch`. Base is `7e171cf`; edits remain uncommitted.
Installed Zen storage and authenticated operation remain NOT RUN.

## Reducing background requests and preserving image downloads

The September 10 report identified frequent API limits and blocked image downloads.
Passive feed lookups now use saved membership only, including expired snapshots.
They neither initialize the account nor refresh remotely. Explicit picker opens
retain account validation and the 30-minute refresh threshold. With no snapshot,
the launcher asks the user to open the picker. Saved-owner labels make clear whose
list drives passive indicators; switch accounts with Reload feeds.

In `content.js`, `primeOnce` no longer opens menus on viewport entry or post hover.
It requires 300 ms on the action row or keyboard focus, cancels on leave, and uses
`apiCooldownActive`, also reused by post-JSON loading. Native overflow controls
stay reachable until adoption. Reddit itself may issue requests independently.

`renderedImageJob` uses only matching posts' canonical HTTPS image URLs; preview
hosts, galleries, video URLs, and conflicting attributes retain the JSON path.
Direct image jobs work during the API cooldown. JSON extraction shares pending
requests and caches up to 100 jobs per tab. A 429 records Retry-After or reset
headers in the feed client's shared storage key and stops without retries.
Uncached galleries/video needing JSON still wait; media-host limits are separate.

PASS: `npm run check`, 60 automated tests, Chrome/Firefox builds, Firefox validation
with zero errors/notices/warnings. PASS: 67 feed browser checks plus a cold-start
smoke check showing zero requests until an explicit picker open. Content tests
cover direct downloads during cooldown, JSON fallback, no retry, shared headers,
request reuse, and deliberate menu loading. Evidence:
`/tmp/reddit-grab-rate-budget-check.log`, `/tmp/reddit-grab-rate-budget-browser-check.json`,
`/tmp/reddit-grab-rate-budget.patch`. Installed Zen live downloads and interaction
remain NOT RUN. Changes are uncommitted on base `7e171cf`.

## Shared queue, local counts, and download recovery

Requirement source: the user's September 10 request to implement suggestions
1 through 3, retain feed lists and counts locally, and audit excess API requests.
Owner: the extension implementation in this checkout. The migration inventory
and Reddit subscriptions are outside this change.

`reddit-requests.js` defines the shared broker and content-tab executor.
`background.js` validates the sending extension, main frame, Reddit origin, and
allowed endpoint before queuing. Reads share in-flight results only within the
same cookie-store/incognito scope. Per-feed verification reads never share an
older read. A maximum of 30 requests may wait; starts are spaced by 1.5 seconds.
The originating tab executes the request with its same-origin session. A queued
write checks the captured URL before starting. Closing the tab releases the queue.
The broker records queue status and a persistent cooldown, without request bodies
or session headers. Rate limits stop pending work without an automatic retry.

`reddit-feeds.js` retains saved feeds until explicit Reload feeds. A normal cached
add uses account GET, member PUT, and verification GET. The verified member array
replaces the affected local feed, so counts come from names rather than speculative
increments. Known-full and already-present picker rows are disabled locally.
A unique durable checkpoint precedes each PUT. Uncertain outcomes require a
fresh read before another attempt. Verification and cache persistence precede
clearing the writer's own checkpoint. A reconciliation read clears only markers
already settled before that read, preserving other tabs' pending writes. Abrupt
tab loss can leave a conservative pending marker; later operations on that feed
then perform an extra GET. No timeout guesses that a queued write finished. Explicit sync skips redundant per-feed reads when the aggregate agrees
with verified membership. A transient sync failure may use saved data with a
warning; authentication failures never use that fallback.

`custom-feeds.js` displays saved owner, sync/update times, cooldown, and queue size.
The local countdown runs only while the picker is open. Storage events update
memberships and counts across tabs through cached-only reads. Offline/cooldown
states retain saved data and disable network actions. Existing timers inspect the
URL, DOM, or local status; they do not poll Reddit.

`content.js` sends JSON failures to `download-failed-post` and resolved media jobs
to `download-media`. `background.js` records only failed items and tracks accepted
browser download IDs through `download-recovery.js`. Completion removes recovery
entries; interruption retains the failed item. A lost retry response after a
browser transfer starts leaves it tracked, preventing a completed download from
being retried. Separate video/audio fallback failures retain only failed streams.
Startup reconciles saved IDs against browser download state without retrying.

`options.html` and `options.js` provide explicit Retry/Dismiss controls. Recovery
messages require the extension settings page. Post extraction retries relay to a
Reddit tab in the saved cookie-store/incognito context. Source URLs are local and
may retain necessary signatures; cookies, modhashes, and headers are excluded.
The list is capped at 100 failures and does not render raw URLs. An unavailable
original container or expired source remains a visible retry error. If Firefox
does not supply cookieStoreId and the original tab is gone, the user must reopen
the post and download it there.

Remaining request sources: intentional native-menu loading can cause Reddit-owned
requests outside the broker, and Reddit itself or other clients can consume the
same account budget. Media-host reads use a separate path so a Reddit JSON
cooldown does not block known direct image downloads. No rate-limit bypass or
identity rotation is implemented. See the README request-count table.

PASS: `npm test`, 97 automated tests. Coverage includes cross-tab queue pacing,
read coalescing with session boundaries, cooldown persistence, worker restart,
request authorization, uncertain feed writes across tabs/restart, local cache
counts, direct images during cooldown, gallery-item recovery, browser interruption,
and a lost response after download start. Log:
`/tmp/reddit-grab-coordinator-tests.log`.

PASS: `npm run check` before the last test-only addition, 96 tests plus Chrome
and Firefox builds and Firefox validation with zero errors, warnings, or notices.
Log: `/tmp/reddit-grab-coordinator-check.log`. Final JavaScript syntax and diff
whitespace checks passed. Environment: Node 22.23.2, npm 10.9.8, macOS.

PASS: options browser smoke, 10 checks covering settings persistence, explicit
retry/dismiss, duplicate clicks, error rendering, and no direct network calls.
Evidence: `/tmp/reddit-grab-options-browser-check.json`. A separate missing-cache
browser check passed with zero requests and disabled cooldown actions:
`/tmp/reddit-grab-missing-cache-browser-check.json`.

PASS: final custom-feed browser fixture, 79 checks against the current sources.
It covers saved account and timestamps, cached counts across tabs, zero-request
passive browsing, offline/cooldown states, failed-sync fallback, and existing
inline picker behavior. Evidence: `/tmp/reddit-grab-final-feed-browser-check.json`.

Verification used base commit `7e171cf` with the source and test patch saved at
`/tmp/reddit-grab-coordinator.patch`, including the new modules.
Installed Zen/Firefox and Chrome execution, authenticated feed writes, and real
network-interrupted downloads remain NOT RUN. Synthetic tests do not establish
those installed-browser boundaries.
