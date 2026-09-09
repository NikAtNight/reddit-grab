// Reddit Media Grab — page UI and post JSON loading.
//
// Reddit hides per-post actions (Follow post, Save, Hide, Report) behind the
// header's "···" overflow dropdown, so each one costs two clicks. This script
// moves those items out of the dropdown into the post header as icon-only
// buttons, and adds its own "Save media" action alongside them.
//
// The items are relocated, not recreated. The real <li> nodes carry the
// handlers Reddit bound to them, so clicking one in the header is genuinely
// the same event as clicking it inside the menu — there is nothing to
// simulate, and no dependency on how those handlers are wired.
//
// Media extraction is intentionally independent of Reddit's rendered markup;
// the DOM is used only to locate a post permalink and an injection point.

(() => {
  "use strict";

  if (globalThis.__redditMediaGrabLoaded) return;
  globalThis.__redditMediaGrabLoaded = true;

  const api = typeof browser !== "undefined" ? browser : chrome;

  const POST_SELECTOR =
    'shreddit-post, article, [data-testid="post-container"], .thing[data-permalink]';
  const OVERFLOW_SELECTORS = [
    "shreddit-post-overflow-menu",
    "rpl-dropdown",
    "faceplate-dropdown-menu",
  ];
  // The trigger carries aria-haspopup rather than a slot attribute.
  const TRIGGER_SELECTORS = [
    'button[aria-haspopup="menu"]',
    'button[slot="trigger"]',
    '[slot="trigger"] button',
    "button",
  ];
  // The action bar is the row holding vote / comments / share. It is a plain
  // flex line with free space to its right, which the credit bar is not.
  const ACTION_BAR_SELECTORS = ["rpl-action-bar", '[slot="action-bar"]'];
  const SHARE_SELECTORS = [
    "shreddit-post-share-button",
    '[data-post-click-location="share"]',
    '[data-post-click-location="comments-button"]',
  ];
  const MENU_SELECTOR = 'faceplate-menu, [role="menu"]';
  const ITEM_SELECTOR = "li[id]";
  const POST_ITEM_SELECTOR = 'li[id^="post-overflow-"]';
  const ADOPTED_ATTR = "data-reddit-media-grab-item";
  const SAVE_MEDIA_LABEL = "Save media";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const BUTTON_SIZE = "32px";
  const ICON_SIZE = "20";

  const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(read, attempts = 25) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const value = read();
      if (value) return value;
      await tick();
    }
    return null;
  }

  // --- Post identification -------------------------------------------------

  function normalizePermalink(value) {
    if (!value) return null;
    try {
      const url = new URL(value, location.origin);
      if (!/(^|\.)reddit\.com$/i.test(url.hostname)) return null;
      const match = url.pathname.match(
        /\/(?:r\/[^/]+\/|(?:user|u)\/[^/]+\/)?comments\/[a-z0-9]+(?:\/[^?#]*)?/i
      );
      return match ? match[0] : null;
    } catch {
      return null;
    }
  }

  function permalinkFrom(element) {
    const direct = [
      element.getAttribute?.("permalink"),
      element.dataset?.permalink,
      element instanceof HTMLAnchorElement ? element.href : null,
    ];
    for (const value of direct) {
      const permalink = normalizePermalink(value);
      if (permalink) return permalink;
    }

    for (const value of [
      element.getAttribute?.("post-id"),
      element.getAttribute?.("thing-id"),
      element.getAttribute?.("id"),
    ]) {
      const postId = String(value || "").replace(/^t3_/i, "");
      if (/^[a-z0-9]+$/i.test(postId)) return `/comments/${postId}`;
    }

    for (const selector of [
      "shreddit-post[permalink]",
      'a[href*="/comments/"]',
      'a[data-post-click-location="comments-button"]',
    ]) {
      const child = element.querySelector?.(selector);
      const value = child?.getAttribute?.("permalink") || child?.href;
      const permalink = normalizePermalink(value);
      if (permalink) return permalink;
    }
    return null;
  }

  // --- Finding the overflow dropdown ---------------------------------------

  // Reddit puts some of these components behind shadow roots, so a plain
  // querySelector is not enough to reach the dropdown or its items.
  function deepQueryAll(root, selector, found = []) {
    found.push(...(root.querySelectorAll?.(selector) || []));
    for (const node of root.querySelectorAll?.("*") || []) {
      if (node.shadowRoot) deepQueryAll(node.shadowRoot, selector, found);
    }
    return found;
  }

  function deepQuery(root, selector) {
    return deepQueryAll(root, selector)[0] || null;
  }

  function menuIn(host) {
    return deepQuery(host, MENU_SELECTOR);
  }

  function triggerIn(host) {
    for (const selector of TRIGGER_SELECTORS) {
      const trigger = deepQuery(host, selector);
      if (trigger) return trigger;
    }
    return null;
  }

  // A post header holds more than one dropdown (author and community cards use
  // them too), so identify the overflow menu by what it contains rather than by
  // document order. Strongest evidence first, because the menu itself is
  // rendered lazily and is often not there yet on the first pass.
  const HOST_TESTS = [
    (host) => menuIn(host)?.querySelector(POST_ITEM_SELECTOR),
    (host) => host.localName === "shreddit-post-overflow-menu",
    (host) => deepQuery(host, 'svg[icon-name="overflow-horizontal"]'),
  ];

  function overflowHostIn(post) {
    const candidates = [];
    for (const selector of OVERFLOW_SELECTORS) deepQueryAll(post, selector, candidates);
    for (const test of HOST_TESTS) {
      const match = candidates.find(test);
      if (match) return match;
    }
    // Every test above is positive evidence of the post overflow menu. A plain
    // dropdown is not: matching one anyway parks a stray row beside the author
    // or community card, which is worse than adding nothing here.
    return null;
  }

  function labelOf(element) {
    const text = element.getAttribute?.("aria-label") || element.textContent || "";
    return text.replace(/\s+/g, " ").trim();
  }

  function isOpen(host) {
    return triggerIn(host)?.getAttribute("aria-expanded") === "true";
  }

  // --- Moving menu items into the header -----------------------------------

  // Everything but the icon is hidden, so the item reads as a round button.
  function keepOnlyIcon(element) {
    for (const child of element.children) {
      if (child.localName === "svg") continue;
      if (child.querySelector("svg")) {
        Object.assign(child.style, {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "auto",
          height: "auto",
          minWidth: "0",
          margin: "0",
          padding: "0",
          gap: "0",
        });
        keepOnlyIcon(child);
      } else {
        child.style.setProperty("display", "none", "important");
      }
    }
  }

  function compactItem(li) {
    li.title = labelOf(li);
    li.setAttribute(ADOPTED_ATTR, li.id);
    Object.assign(li.style, { listStyle: "none", margin: "0", flex: "0 0 auto" });

    const item = li.querySelector('[role="menuitem"]') || li;
    keepOnlyIcon(item);
    Object.assign(item.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      borderRadius: "50%",
      gap: "0",
    });
    // Reddit sets padding-inline-end inline on the menu item.
    item.style.setProperty("padding", "0", "important");
    item.style.setProperty("padding-inline-end", "0", "important");

    for (const svg of li.querySelectorAll("svg")) {
      svg.setAttribute("width", ICON_SIZE);
      svg.setAttribute("height", ICON_SIZE);
    }
  }

  // `faceplate-tracker` wraps some items for analytics; it is display:contents,
  // so taking it along keeps Reddit's tracking intact without affecting layout.
  function outermost(li) {
    return li.parentElement?.localName === "faceplate-tracker" ? li.parentElement : li;
  }

  function adoptItem(row, li, before) {
    const existing = row.querySelector(`[${ADOPTED_ATTR}="${li.id}"]`);
    if (existing) outermost(existing).remove();
    compactItem(li);
    row.insertBefore(outermost(li), before);
  }

  function syncItems(row, host, before) {
    const items = menuIn(host)?.querySelectorAll(ITEM_SELECTOR) || [];
    if (!items.length) return false;
    for (const li of [...items]) adoptItem(row, li, before);
    hideTrigger(host);
    return true;
  }

  // Once every item lives in the header the "···" button is redundant. It stays
  // until then, so a post whose menu never renders keeps its actions reachable.
  function hideTrigger(host) {
    const trigger = triggerIn(host);
    if (!trigger) return;
    Object.assign(trigger.style, {
      position: "absolute",
      width: "1px",
      height: "1px",
      opacity: "0",
      pointerEvents: "none",
    });
  }

  function watchMenu(row, host, before) {
    let adoptions = syncItems(row, host, before) ? 1 : 0;
    // The menu does not exist on the first pass — Reddit loads it through
    // `shreddit-async-loader` — and lit rebuilds it after some actions. Keep
    // adopting rather than stopping at the first success, so items Reddit
    // re-renders do not end up stranded back inside the dropdown. The cap is a
    // runaway guard in case Reddit ever insists on putting them back.
    const observer = new MutationObserver(() => {
      if (!row.parentNode || adoptions >= 10) return observer.disconnect();
      if (syncItems(row, host, before)) adoptions++;
    });
    observer.observe(host, { childList: true, subtree: true });
  }

  // Reddit builds a post's menu only when its dropdown is first opened, so the
  // items have to be asked for. Open it behind an opacity clamp, take them, and
  // close it again. Opacity rather than visibility, so nothing Reddit does
  // depends on the menu reporting itself as hidden.
  async function primeMenu(row, host, before) {
    if (syncItems(row, host, before)) return;

    const previous = host.getAttribute("style");
    host.setAttribute(
      "style",
      `${previous ? `${previous};` : ""}opacity:0!important;pointer-events:none!important`
    );
    try {
      triggerIn(host)?.click();
      await waitFor(() => menuIn(host)?.querySelector(ITEM_SELECTOR));
      syncItems(row, host, before);
      if (isOpen(host)) triggerIn(host)?.click();
      await waitFor(() => !isOpen(host), 5);
    } finally {
      await tick(60);
      if (previous === null) host.removeAttribute("style");
      else host.setAttribute("style", previous);
    }
  }

  // Reddit closes whichever dropdown is already open when another one opens, so
  // priming several posts at once makes them fight. One at a time.
  let primeQueue = Promise.resolve();

  // Primed when the post scrolls into view rather than on hover: waiting for
  // the pointer leaves most of the feed showing nothing but "Save media", and
  // priming the whole feed up front opens far too many dropdowns at once.
  function primeOnce(post, row, host, before) {
    let observer = null;
    let started = false;

    const start = () => {
      if (started) return;
      started = true;
      observer?.disconnect();
      post.removeEventListener("pointerenter", start);
      primeQueue = primeQueue.then(() => primeMenu(row, host, before)).catch(() => {});
    };

    if (typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) start();
      });
      observer.observe(post);
    }
    // Hover still counts, in case the post is already on screen and the
    // intersection callback has not run yet.
    post.addEventListener("pointerenter", start);
  }

  // --- Save media ----------------------------------------------------------

  // Built as real nodes rather than innerHTML so the row still renders if
  // Reddit ever enforces Trusted Types on the page.
  function downloadIcon() {
    const root = document.createElementNS(SVG_NS, "svg");
    for (const [name, value] of Object.entries({
      viewBox: "0 0 24 24",
      width: ICON_SIZE,
      height: ICON_SIZE,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    })) {
      root.setAttribute(name, value);
    }
    for (const d of [
      "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
      "M7 10l5 5 5-5",
      "M12 15V3",
    ]) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      root.appendChild(path);
    }
    return root;
  }

  function createSaveMediaButton(permalink) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = SAVE_MEDIA_LABEL;
    button.setAttribute("aria-label", SAVE_MEDIA_LABEL);
    Object.assign(button.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      flex: "0 0 auto",
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      padding: "0",
      margin: "0",
      border: "0",
      borderRadius: "50%",
      background: "transparent",
      color: "currentColor",
      cursor: "pointer",
      lineHeight: "0",
    });
    button.appendChild(downloadIcon());

    let busy = false;
    let resetTimer = null;
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      busy = true;
      clearTimeout(resetTimer);
      button.title = "Preparing…";
      button.style.color = "#d93900";

      try {
        const result = await downloadPost(permalink, (status) => {
          button.title = status;
        });
        button.title = result.failed
          ? `${result.saved} saved, ${result.failed} failed`
          : result.separateAudio
            ? "Saved video + separate audio"
            : `${result.saved} saved`;
        button.style.color = result.failed || result.separateAudio ? "#9a6700" : "#16833b";
      } catch (error) {
        console.error("[Reddit Media Grab]", error);
        button.title = error.message;
        button.style.color = "#d93900";
      }

      resetTimer = setTimeout(() => {
        busy = false;
        button.title = SAVE_MEDIA_LABEL;
        button.style.color = "currentColor";
      }, 2600);
    });

    return button;
  }

  // --- Injection -----------------------------------------------------------

  // The "···" is boxed in by wrappers sized to exactly one icon — Reddit's
  // `shreddit-async-loader` around it is `w-xl h-xl`. A row inserted as its
  // sibling overflows that box instead of sitting in the credit bar. Climb out
  // of any wrapper that exists solely to hold the button and insert before the
  // outermost one, which lands the row in the bar's trailing flex group next
  // to the join button, where there is room to grow.
  // Never climbs past the post: the row has to land inside it, because a row
  // outside is a row `decorate` cannot see, and it would re-inject on every
  // rescan.
  function insertionAnchor(node, post) {
    for (let depth = 0; depth < 4; depth++) {
      const parent = node.parentNode;
      if (!parent?.parentNode || parent === post || parent.children?.length !== 1) break;
      node = parent;
    }
    return node;
  }

  // Anchor to the share button rather than to the action bar element. The bar
  // is a wrapper around the button row, so appending to it drops the icons onto
  // their own line underneath instead of continuing the row.
  function actionBarInsertFor(post) {
    for (const selector of SHARE_SELECTORS) {
      const button = deepQuery(post, selector);
      if (!button) continue;
      const anchor = insertionAnchor(button, post);
      if (anchor.parentNode) {
        return (row) => anchor.parentNode.insertBefore(row, anchor.nextSibling);
      }
    }
    for (const selector of ACTION_BAR_SELECTORS) {
      const bar = deepQuery(post, selector);
      if (bar) return (row) => bar.appendChild(row);
    }
    return null;
  }

  function injectionPointFor(post) {
    const host = overflowHostIn(post);
    const insert = actionBarInsertFor(post);
    if (insert) return { host, insert };
    // Fall back to the credit bar. It is cramped — the "···" is boxed in by
    // wrappers sized to exactly one icon — so climb out of any wrapper holding
    // nothing but the button, rather than inserting as its sibling.
    if (host?.parentNode) {
      const anchor = insertionAnchor(host, post);
      return { host, insert: (row) => anchor.parentNode.insertBefore(row, anchor) };
    }
    // Old Reddit has no overflow dropdown, only its inline action list. There
    // is nothing to move there, but "Save media" still applies.
    const buttons = post.querySelector?.(".flat-list.buttons");
    if (buttons) return { host: null, insert: (row) => buttons.appendChild(row) };
    return null;
  }

  function decorate(post) {
    // The row already being in the post is the only thing that suppresses a
    // second one. Reddit nests `shreddit-post` and `article`, so a post matches
    // POST_SELECTOR twice; marking the dropdown instead would both miss the
    // case where the emptied menu makes the second pass pick a neighbouring
    // dropdown, and permanently suppress the row if Reddit ever re-renders the
    // credit bar out from under it.
    if (post.querySelector(".reddit-media-grab-actions")) return;
    const permalink = permalinkFrom(post);
    if (!permalink) return;
    const point = injectionPointFor(post);
    if (!point) return;

    const row = document.createElement("span");
    row.className = "reddit-media-grab-actions";
    Object.assign(row.style, {
      display: "inline-flex",
      alignItems: "center",
      flex: "0 0 auto",
      gap: "0px",
      // Reddit covers the whole card with `a[slot=full-post-link].absolute
      // .inset-0`, which paints over static content and swallows the click,
      // navigating to the post. Its own controls sit above that overlay by
      // being positioned; do the same rather than fighting the click.
      position: "relative",
      // Pushes the row to the end of the action bar, leaving the gap between
      // it and the vote/comment/share group. An auto margin does this without
      // touching Reddit's own container styles, and collapses harmlessly to 0
      // if that container turns out not to be full width.
      marginInlineStart: "auto",
      padding: "0",
      whiteSpace: "nowrap",
      verticalAlign: "middle",
    });

    // Save media stays last; adopted items are inserted before it.
    const saveMedia = createSaveMediaButton(permalink);
    row.appendChild(saveMedia);
    point.insert(row);

    if (point.host) {
      watchMenu(row, point.host, saveMedia);
      primeOnce(post, row, point.host, saveMedia);
    }
  }

  function scan() {
    for (const post of document.querySelectorAll(POST_SELECTOR)) decorate(post);
  }

  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      scan();
    }, 150);
  }

  scan();
  new MutationObserver(queueScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // --- Download ------------------------------------------------------------

  function mediaModule() {
    if (!globalThis.RedditGrabMedia) throw new Error("Media extractor did not load");
    return globalThis.RedditGrabMedia;
  }

  async function fetchWithRetry(url, onStatus, attempts = 3) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const response = await fetch(url, { credentials: "same-origin" });
      if (response.status !== 429) return response;
      if (attempt === attempts - 1) throw new Error("Reddit rate limit reached — try again shortly");
      const delay = Math.min(Number(response.headers.get("retry-after")) || 4 * 2 ** attempt, 30);
      for (let remaining = delay; remaining > 0; remaining--) {
        onStatus?.(`Retrying in ${remaining}s…`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    throw new Error("Unable to load the Reddit post");
  }

  async function downloadPost(permalink, onStatus) {
    const media = mediaModule();
    const response = await fetchWithRetry(
      media.redditJsonUrl(permalink, location.origin),
      onStatus
    );
    if (!response.ok) throw new Error(`Reddit returned ${response.status}`);
    const listing = await response.json();
    const post = listing?.[0]?.data?.children?.[0]?.data;
    if (!post) throw new Error("Reddit returned an unexpected response");

    const job = media.extractMedia(post);
    if (!job.items.length) throw new Error("This post has no downloadable media");

    const result = await api.runtime.sendMessage({ type: "download-media", job });
    if (!result?.ok) throw new Error(result?.error || "Download failed");
    return result;
  }

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "download-current-post") return undefined;
    const permalink = normalizePermalink(location.pathname);
    if (!permalink) {
      sendResponse({ ok: false, error: "Open a Reddit post first" });
      return undefined;
    }
    downloadPost(permalink)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
