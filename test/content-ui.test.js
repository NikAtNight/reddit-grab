import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// A minimal DOM good enough for content.js: element tree, attributes, the
// selector subset the content script actually uses, and synchronous clicks.

function camelToKebab(key) {
  return key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

function kebabToCamel(name) {
  return name.replace(/-([a-z])/g, (_match, character) => character.toUpperCase());
}

function makeStyle() {
  const style = {};
  Object.defineProperty(style, "setProperty", {
    value: (name, value) => {
      style[kebabToCamel(name)] = value;
    },
  });
  return style;
}

function matchesCompound(element, compound) {
  if (compound === "*") return true;
  const tokens = compound.match(/(^[a-z][\w-]*)|\.[\w-]+|\[[^\]]+\]/gi) || [];
  for (const token of tokens) {
    if (token.startsWith(".")) {
      const classes = (element.getAttribute("class") || "").split(/\s+/);
      if (!classes.includes(token.slice(1))) return false;
    } else if (token.startsWith("[")) {
      const parts = token.slice(1, -1).match(/^([\w-]+)(?:([*^$]?=)"?([^"]*)"?)?$/);
      const value = element.getAttribute(parts[1]);
      if (value === null) return false;
      if (parts[2] === "=" && value !== parts[3]) return false;
      if (parts[2] === "*=" && !value.includes(parts[3])) return false;
      if (parts[2] === "^=" && !value.startsWith(parts[3])) return false;
      if (parts[2] === "$=" && !value.endsWith(parts[3])) return false;
    } else if (element.localName !== token.toLowerCase()) {
      return false;
    }
  }
  return true;
}

// Split on descendant combinators only; whitespace inside [attr="a b"] stays.
function splitGroup(group) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const character of group.trim()) {
    if (character === "[") depth++;
    else if (character === "]") depth--;
    if (/\s/.test(character) && depth === 0) {
      if (current) parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function matchesSelector(element, selector) {
  return selector.split(",").some((group) => {
    const parts = splitGroup(group);
    if (!matchesCompound(element, parts[parts.length - 1])) return false;
    let index = parts.length - 2;
    let node = element.parentNode;
    while (index >= 0) {
      if (!node) return false;
      if (matchesCompound(node, parts[index])) index--;
      node = node.parentNode;
    }
    return true;
  });
}

class FakeElement {
  constructor(tagName) {
    this.localName = String(tagName).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributeMap = new Map();
    this.handlers = new Map();
    this.style = makeStyle();
    this.shadowRoot = null;
    this.ownText = "";
    this.dataset = new Proxy(
      {},
      {
        get: (_target, key) => this.attributeMap.get(`data-${camelToKebab(key)}`),
        set: (_target, key, value) => {
          this.attributeMap.set(`data-${camelToKebab(key)}`, String(value));
          return true;
        },
        has: (_target, key) => this.attributeMap.has(`data-${camelToKebab(key)}`),
      }
    );
  }

  get id() {
    return this.getAttribute("id") || "";
  }

  get parentElement() {
    return this.parentNode;
  }

  get nextSibling() {
    const siblings = this.parentNode?.children || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  set className(value) {
    this.setAttribute("class", value);
  }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this.ownText = value;
    this.children = [];
  }

  getAttribute(name) {
    return this.attributeMap.has(name) ? this.attributeMap.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributeMap.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributeMap.delete(name);
  }

  appendChild(child) {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(node, reference) {
    node.remove();
    const index = this.children.indexOf(reference);
    node.parentNode = this;
    this.children.splice(index === -1 ? this.children.length : index, 0, node);
    return node;
  }

  remove() {
    const index = this.parentNode?.children.indexOf(this) ?? -1;
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  cloneNode(deep) {
    const copy = new FakeElement(this.localName);
    copy.attributeMap = new Map(this.attributeMap);
    copy.ownText = this.ownText;
    if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of [...node.children]) {
        if (matchesSelector(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  addEventListener(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this.handlers.get(type) || [];
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  }

  dispatch(type) {
    const event = { type, preventDefault() {}, stopPropagation() {} };
    for (const handler of [...(this.handlers.get(type) || [])]) handler(event);
  }

  click() {
    this.dispatch("click");
  }
}

function element(tagName, attributes = {}, text = "") {
  const node = new FakeElement(tagName);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.ownText = text;
  return node;
}

// Mirrors the real overflow markup:
//   li[id] > div[role=menuitem] > span > [span > svg, span > span "label"]
// The award item is wrapped in a faceplate-tracker, as Reddit does.
const MENU_ITEMS = [
  { id: "post-overflow-follow", label: "Follow post", icon: "notifications" },
  { id: "post-overflow-award", label: "Award this post", icon: "award", tracked: true },
  { id: "post-overflow-save", label: "Save", icon: "save" },
  { id: "post-overflow-hide", label: "Hide", icon: "hide" },
  { id: "post-overflow-report", label: "Report", icon: "report" },
];

function buildMenu(clicks) {
  const menu = element("faceplate-menu", { slot: "content" });
  for (const { id, label, icon, tracked } of MENU_ITEMS) {
    const li = element("li", { id, role: "presentation" });
    const item = element("div", {
      role: "menuitem",
      tabindex: "-1",
      style: "padding-inline-end:16px",
    });

    const group = element("span");
    const iconSlot = element("span");
    iconSlot.appendChild(element("svg", { "icon-name": icon, fill: "currentColor" }));
    const textColumn = element("span");
    textColumn.appendChild(element("span", {}, label));
    group.appendChild(iconSlot);
    group.appendChild(textColumn);

    item.appendChild(group);
    item.appendChild(element("span")); // trailing empty slot Reddit renders
    item.addEventListener("click", () => {
      clicks[id] = (clicks[id] || 0) + 1;
    });
    li.appendChild(item);

    if (tracked) {
      const tracker = element("faceplate-tracker", { source: "post", action: "click" });
      tracker.appendChild(li);
      menu.appendChild(tracker);
    } else {
      menu.appendChild(li);
    }
  }
  return menu;
}

// Mirrors the real credit bar:
//
//   span[slot=credit-bar].flex.justify-between
//     span.flex.flex-wrap.min-w-0            <- subreddit, timestamp, author card
//     span.flex.items-center.ps-xs           <- trailing group, has room to grow
//       shreddit-join-button
//       span.flex.items-center.-me-[7px]     <- wrapper, single child
//         shreddit-async-loader.w-xl.h-xl    <- sized to exactly one icon
//           shreddit-post-overflow-menu
//             button[aria-haspopup=menu] > svg[icon-name=overflow-horizontal]
//
// Reddit also nests article > shreddit-post, so a post matches twice.
function buildPost({ lazyMenu = false, noOverflow = false, noActionBar = false } = {}) {
  const clicks = {};
  const article = element("article", { "data-post-id": "t3_abc123" });
  const post = element("shreddit-post", {
    permalink: "/r/interesting/comments/abc123/tray-defense/",
  });
  // Covers the whole card and navigates to the post if a click reaches it.
  post.appendChild(
    element("a", { slot: "full-post-link", class: "absolute inset-0" })
  );
  const header = element("span", { slot: "credit-bar", class: "flex justify-between" });

  // The author card is a dropdown with a menu trigger too, so it is a genuine
  // candidate whenever the post overflow menu cannot be identified by content.
  const left = element("span", { class: "flex flex-wrap items-center min-w-0" });
  const authorDropdown = element("rpl-dropdown");
  const authorTrigger = element("button", {
    "aria-label": "Open author card",
    "aria-haspopup": "menu",
  });
  authorTrigger.appendChild(element("svg", { "icon-name": "user" }));
  authorDropdown.appendChild(authorTrigger);
  left.appendChild(authorDropdown);

  const right = element("span", { class: "flex items-center ps-xs" });
  right.appendChild(element("shreddit-join-button"));

  const overflow = element("shreddit-post-overflow-menu");
  const trigger = element("button", {
    "aria-label": "Open user actions",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
  });
  trigger.appendChild(element("svg", { "icon-name": "overflow-horizontal" }));
  trigger.addEventListener("click", () => {
    if (trigger.getAttribute("aria-expanded") === "true") {
      trigger.setAttribute("aria-expanded", "false");
    } else {
      if (!overflow.querySelector("faceplate-menu")) overflow.appendChild(buildMenu(clicks));
      trigger.setAttribute("aria-expanded", "true");
    }
  });
  overflow.appendChild(trigger);
  if (!lazyMenu) overflow.appendChild(buildMenu(clicks));

  const loader = element("shreddit-async-loader", {
    class: "relative w-xl h-xl",
    bundlename: "shreddit_post_overflow_menu",
  });
  const iconWrapper = element("span", { class: "flex items-center -me-[7px]" });
  if (!noOverflow) {
    loader.appendChild(overflow);
    iconWrapper.appendChild(loader);
    right.appendChild(iconWrapper);
  }

  header.appendChild(left);
  header.appendChild(right);
  post.appendChild(header);

  // vote / comments / share. The bar is a wrapper around the button row, so
  // anything appended to the bar itself lands on a line of its own underneath.
  const actionBar = element("rpl-action-bar");
  const buttonRow = element("div", { class: "flex items-center gap-sm" });
  buttonRow.appendChild(element("shreddit-post-vote-button"));
  buttonRow.appendChild(element("button", { "data-post-click-location": "comments-button" }));
  const share = element("shreddit-post-share-button");
  buttonRow.appendChild(share);
  actionBar.appendChild(buttonRow);
  if (!noActionBar) post.appendChild(actionBar);

  article.appendChild(post);

  const root = new FakeElement("html");
  root.appendChild(article);
  return {
    root,
    article,
    post,
    header,
    right,
    iconWrapper,
    loader,
    overflow,
    trigger,
    actionBar,
    buttonRow,
    share,
    clicks,
  };
}

function makeContext(root, extras = {}) {
  const observers = [];
  const viewportObservers = [];
  const context = {
    URL,
    HTMLAnchorElement: class {},
    console,
    setTimeout,
    clearTimeout,
    document: {
      documentElement: root,
      createElement: (tag) => new FakeElement(tag),
      createElementNS: (_namespace, tag) => new FakeElement(tag),
      querySelectorAll: (selector) => root.querySelectorAll(selector),
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.active = false;
        observers.push(this);
      }
      observe() {
        this.active = true;
      }
      disconnect() {
        this.active = false;
      }
    },
    IntersectionObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.targets = [];
        viewportObservers.push(this);
      }
      observe(target) {
        this.targets.push(target);
      }
      disconnect() {
        this.targets = [];
      }
    },
    location: { origin: "https://www.reddit.com", pathname: "/" },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async () => ({ ok: true, saved: 2 }),
      },
    },
    ...extras,
  };
  context.globalThis = context;
  const notify = () => {
    for (const observer of [...observers]) if (observer.active) observer.callback([], observer);
  };
  const scrollIntoView = () => {
    for (const observer of [...viewportObservers]) {
      if (!observer.targets.length) continue;
      observer.callback(
        observer.targets.map((target) => ({ target, isIntersecting: true })),
        observer
      );
    }
  };
  return { context, notify, scrollIntoView };
}

async function loadContentScript(root, extras) {
  const loaded = makeContext(root, extras);
  vm.runInNewContext(await readFile("content.js", "utf8"), loaded.context);
  return loaded;
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const actionRow = (post) => post.querySelector(".reddit-media-grab-actions");
const adoptedIds = (row) =>
  row.querySelectorAll("[data-reddit-media-grab-item]").map((node) => node.id);

test("moves the real menu items out of the dropdown instead of copying them", async () => {
  const { root, post, overflow } = buildPost();

  await loadContentScript(root);

  const row = actionRow(post);
  assert.deepEqual(
    adoptedIds(row),
    MENU_ITEMS.map((item) => item.id)
  );
  // Moved, not cloned: the menu is left empty.
  assert.equal(overflow.querySelector("li[id]"), null);
  // Save media stays last.
  assert.equal(row.children[row.children.length - 1].getAttribute("aria-label"), "Save media");
});

test("puts the row inline in the action bar, right after share", async () => {
  const { root, post, header, actionBar, buttonRow, share } = buildPost();

  await loadContentScript(root);

  const row = actionRow(post);
  // Must join the button row itself. Appending to the bar wrapper would put
  // the icons on their own line underneath.
  assert.equal(row.parentNode, buttonRow);
  assert.equal(buttonRow.children.indexOf(row), buttonRow.children.indexOf(share) + 1);
  assert.equal(actionBar.children.length, 1);
  // Pushed to the far end of the bar, away from vote/comments/share.
  assert.equal(row.style.marginInlineStart, "auto");
  // Must sit above a[slot=full-post-link].absolute.inset-0, which otherwise
  // paints over the row and turns every click into "open the post".
  assert.ok(post.querySelector('[slot="full-post-link"]'));
  assert.equal(row.style.position, "relative");
  // The credit bar is too cramped to hold it; nothing goes there.
  assert.equal(header.querySelector(".reddit-media-grab-actions"), null);
});

test("falls back to the credit bar when a post has no action bar", async () => {
  const { root, post, right, iconWrapper, loader } = buildPost({ noActionBar: true });

  await loadContentScript(root);

  const row = actionRow(post);
  // Reddit's async loader is w-xl h-xl, so a row placed inside it overflows.
  assert.equal(loader.querySelector(".reddit-media-grab-actions"), null);
  assert.equal(iconWrapper.querySelector(".reddit-media-grab-actions"), null);
  assert.equal(row.parentNode, right);
  assert.equal(right.children.indexOf(row), right.children.indexOf(iconWrapper) - 1);
});

test("clicking a moved item fires the handler Reddit bound to it", async () => {
  const { root, post, header, clicks } = buildPost();

  await loadContentScript(root);

  const report = actionRow(post).querySelector('[data-reddit-media-grab-item="post-overflow-report"]');
  report.querySelector('[role="menuitem"]').click();

  assert.equal(clicks["post-overflow-report"], 1);
});

test("keeps the icon, hides the label, and retires the ··· button", async () => {
  const { root, post, header, trigger } = buildPost();

  await loadContentScript(root);

  const follow = actionRow(post).querySelector('[data-reddit-media-grab-item="post-overflow-follow"]');
  assert.equal(follow.title, "Follow post");
  // The icon's ancestors stay laid out; the text column is hidden.
  const [iconSlot, textColumn] = follow.querySelector('[role="menuitem"]').children[0].children;
  assert.ok(iconSlot.querySelector("svg"));
  assert.notEqual(iconSlot.style.display, "none");
  assert.equal(textColumn.style.display, "none");
  // Reddit's inline padding-inline-end is overridden.
  assert.equal(follow.querySelector('[role="menuitem"]').style.paddingInlineEnd, "0");
  assert.equal(trigger.style.opacity, "0");
});

test("carries the faceplate-tracker wrapper so analytics stay attached", async () => {
  const { root, post } = buildPost();

  await loadContentScript(root);

  const award = actionRow(post).querySelector('[data-reddit-media-grab-item="post-overflow-award"]');
  assert.equal(award.parentElement.localName, "faceplate-tracker");
  assert.equal(award.parentElement.parentElement, actionRow(post));
});

test("ignores unrelated dropdowns in the same header", async () => {
  const { root, post, header, buttonRow } = buildPost();

  await loadContentScript(root);

  // The author card dropdown comes first in document order but owns no menu.
  const authorDropdown = header.querySelector("rpl-dropdown");
  assert.equal(authorDropdown.querySelector(".reddit-media-grab-actions"), null);
  assert.equal(actionRow(post).parentNode, buttonRow);
  assert.equal(adoptedIds(actionRow(post)).length, MENU_ITEMS.length);
});

test("adds nothing when no dropdown is identifiably the post overflow menu", async () => {
  const { root, post, header } = buildPost({ noOverflow: true, noActionBar: true });

  await loadContentScript(root);

  // Only the author card remains. A stray row beside it is worse than nothing.
  assert.ok(header.querySelector("rpl-dropdown"));
  assert.equal(actionRow(post), null);
});

test("adopts items that Reddit renders after the first pass", async () => {
  const { root, post, header, overflow, clicks, trigger } = buildPost({ lazyMenu: true });

  const { notify } = await loadContentScript(root);
  // Only Save media until the menu exists, and ··· stays reachable.
  assert.deepEqual(adoptedIds(actionRow(post)), []);
  assert.equal(trigger.style.opacity, undefined);

  // Reddit's async loader fetches the bundle and renders the menu later.
  overflow.appendChild(buildMenu(clicks));
  notify();
  await settle(50);

  assert.deepEqual(
    adoptedIds(actionRow(post)),
    MENU_ITEMS.map((item) => item.id)
  );
  assert.equal(trigger.style.opacity, "0");
});

test("scrolling and hovering a post do not load its lazy menu", async () => {
  const { root, article, post, overflow, trigger } = buildPost({ lazyMenu: true });

  const { scrollIntoView } = await loadContentScript(root);
  scrollIntoView();
  article.dispatch("pointerenter");
  post.dispatch("pointerenter");
  await settle(400);
  assert.deepEqual(adoptedIds(actionRow(post)), []);
  assert.equal(overflow.querySelector("faceplate-menu"), null);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(trigger.style.opacity, undefined);
});

test("dwelling on one action row primes only its menu", async () => {
  const first = buildPost({ lazyMenu: true });
  const second = buildPost({ lazyMenu: true });
  const root = new FakeElement("html");
  root.appendChild(first.article);
  root.appendChild(second.article);

  const { scrollIntoView } = await loadContentScript(root);
  scrollIntoView();
  actionRow(first.post).dispatch("pointerenter");
  await settle(600);

  assert.deepEqual(adoptedIds(actionRow(first.post)), MENU_ITEMS.map((item) => item.id));
  assert.deepEqual(adoptedIds(actionRow(second.post)), []);
  assert.equal(first.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(first.overflow.getAttribute("style"), null);
});

test("leaving the action row cancels loading; keyboard focus can load it", async () => {
  const { root, post, overflow } = buildPost({ lazyMenu: true });

  await loadContentScript(root);
  actionRow(post).dispatch("pointerenter");
  actionRow(post).dispatch("pointerleave");
  await settle(400);
  assert.equal(overflow.querySelector("faceplate-menu"), null);
  actionRow(post).dispatch("focusin");
  await settle(500);

  assert.deepEqual(
    adoptedIds(actionRow(post)),
    MENU_ITEMS.map((item) => item.id)
  );
});

test("action-row interaction does not prime menus during a shared API cooldown", async () => {
  const { root, post, overflow, trigger } = buildPost({ lazyMenu: true });
  const { context } = await loadContentScript(root);
  context.chrome.storage = { local: { get: async () => ({ redditGrabFeedCooldown: Date.now() + 120000 }) } };
  actionRow(post).dispatch("pointerenter");
  await settle(400);
  assert.equal(overflow.querySelector("faceplate-menu"), null);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(trigger.style.opacity, undefined);
});

test("injects one row per post even though article and shreddit-post both match", async () => {
  const { root, post, header } = buildPost();

  const { notify } = await loadContentScript(root);
  notify();
  await settle(250);

  // Both the initial scan and later rescans must stay at one row, even though
  // the emptied menu makes the real dropdown harder to recognise afterwards.
  assert.equal(post.querySelectorAll(".reddit-media-grab-actions").length, 1);
  assert.equal(post.querySelectorAll('[aria-label="Save media"]').length, 1);
});

test("rebuilds the row if Reddit re-renders the post out from under it", async () => {
  const { root, post, buttonRow } = buildPost();

  const { notify } = await loadContentScript(root);
  assert.ok(actionRow(post));

  actionRow(post).remove();
  notify();
  await settle(250);

  const row = actionRow(post);
  assert.ok(row, "the row must come back rather than disappearing for good");
  assert.equal(row.parentNode, buttonRow);
});

test("the Save media icon downloads the post it was injected for", async () => {
  const { root, post } = buildPost();

  let requested = null;
  let job = null;
  const { context } = await loadContentScript(root, {
    fetch: async (url) => {
      requested = url;
      return {
        ok: true,
        status: 200,
        json: async () => [{ data: { children: [{ data: { id: "abc123" } }] } }],
      };
    },
  });
  context.RedditGrabMedia = {
    redditJsonUrl: (permalink, origin) => `${origin}${permalink}.json`,
    extractMedia: () => ({ items: [{ url: "https://i.redd.it/a.jpg" }] }),
  };
  context.chrome.runtime.sendMessage = async (message) => {
    job = message.job;
    return { ok: true, saved: 2 };
  };

  const row = actionRow(post);
  const saveMedia = row.children[row.children.length - 1];
  saveMedia.click();
  await settle(50);

  assert.equal(
    requested,
    "https://www.reddit.com/r/interesting/comments/abc123/tray-defense/.json"
  );
  assert.equal(job.items.length, 1);
  assert.equal(saveMedia.title, "2 saved");
});

async function downloadFixture(root, fetcher, state = {}) {
  let listener;
  const jobs = [];
  const messages = [];
  const loaded = await loadContentScript(root, {
    fetch: fetcher,
    location: { origin: "https://www.reddit.com", pathname: "/r/interesting/comments/abc123/tray-defense/" },
    chrome: {
      storage: { local: {
        get: async (key) => ({ [key]: state[key] }),
        set: async (values) => Object.assign(state, values),
      } },
      runtime: {
        id: "extension",
        onMessage: { addListener(value) { listener = value; } },
        sendMessage: async message => {
          messages.push(message);
          if (message.type === "download-media") jobs.push(message.job);
          return { ok: true, saved: message.job.items.length };
        },
      },
    },
  });
  vm.runInNewContext(await readFile("reddit-media.js", "utf8"), loaded.context);
  return {
    jobs, state, messages, context: loaded.context,
    download: () => new Promise(resolve => listener({ type: "download-current-post" }, {}, resolve)),
    retry: (permalink, recoveryId) => new Promise(resolve => listener({ type: "retry-download-post", permalink, recoveryId }, { id: "extension" }, resolve)),
  };
}

test("canonical rendered images download during API cooldown without requesting JSON", async () => {
  for (const attribute of ["content-href", "content-url"]) {
    const { root, post } = buildPost();
    post.setAttribute(attribute, "https://i.redd.it/full-original.png");
    post.setAttribute("subreddit-name", "interesting");
    const { download, jobs } = await downloadFixture(root, async () => { throw new Error("Unexpected API request"); }, {
      redditGrabFeedCooldown: Date.now() + 120000,
    });
    assert.equal((await download()).ok, true);
    assert.equal(jobs[0].postId, "abc123");
    assert.equal(jobs[0].subreddit, "interesting");
    assert.equal(jobs[0].items[0].url, "https://i.redd.it/full-original.png");
  }
});

test("failed post JSON is saved for explicit retry with the original post identity", async () => {
  const { root } = buildPost();
  const fixture = await downloadFixture(root, async () => new Response("Limited", { status: 429 }));
  const result = await fixture.download();
  assert.equal(result.ok, false);
  assert.match(result.error, /Failed downloads/);
  assert.equal(fixture.jobs.length, 0);
  assert.equal(fixture.messages[0].type, "download-failed-post");
  assert.equal(fixture.messages[0].job.items[0].kind, "post");
  assert.match(fixture.messages[0].job.items[0].url, /comments\/abc123\//);
});

test("post recovery keeps the queued post target even from another page and uses the shared coordinator", async () => {
  const { root } = buildPost();
  const fixture = await downloadFixture(root, async () => { throw new Error("Must use request coordinator"); });
  const requests = [];
  fixture.context.RedditGrabRequests = { fetch: async url => {
    requests.push(url);
    return Response.json([{ data: { children: [{ data: { id: "def456", url: "https://i.redd.it/full.jpg" } }] } }]);
  } };
  const result = await fixture.retry("/r/pics/comments/def456/another/", "recovery-example");
  assert.equal(result.ok, true);
  assert.match(requests[0], /comments\/def456\/another\.json/);
  assert.equal(fixture.jobs[0].postId, "def456");
  assert.equal(fixture.messages[0].recoveryId, "recovery-example");
});

test("preview images, galleries, videos, and conflicting canonical links keep JSON extraction", async () => {
  const cases = [
    { attrs: { "content-href": "https://preview.redd.it/thumb.jpg?width=320" }, fixture: "gallery" },
    { attrs: { "content-href": "https://www.reddit.com/gallery/abc123" }, fixture: "gallery" },
    { attrs: { "content-href": "https://v.redd.it/abc123" }, fixture: "video" },
    { attrs: { "content-href": "https://i.redd.it/first.jpg", "content-url": "https://www.reddit.com/gallery/abc123" }, fixture: "gallery" },
    { attrs: {}, fixture: "gallery" },
  ];
  for (const { attrs, fixture } of cases) {
    const { root, post } = buildPost();
    for (const [name, value] of Object.entries(attrs)) post.setAttribute(name, value);
    post.appendChild(element("img", { src: "https://i.redd.it/thumbnail.jpg" }));
    const json = JSON.parse(await readFile(`test/fixtures/${fixture}.json`, "utf8"));
    let requests = 0;
    const { download, jobs } = await downloadFixture(root, async () => {
      requests++;
      return Response.json([{ data: { children: [{ data: json }] } }]);
    });
    assert.equal((await download()).ok, true);
    assert.equal(requests, 1);
    if (fixture === "gallery") assert.equal(jobs[0].items.length, 2);
    else assert.equal(jobs[0].items[0].kind, "reddit-video");
  }
});

test("a 429 saves Retry-After and blocks later JSON requests without retrying", async () => {
  const { root } = buildPost();
  let requests = 0;
  const before = Date.now();
  const { download, state } = await downloadFixture(root, async () => {
    requests++;
    return new Response("Limited", { status: 429, headers: { "Retry-After": "180" } });
  });
  assert.match((await download()).error, /rate limit/);
  assert.ok(state.redditGrabFeedCooldown >= before + 180000);
  assert.match((await download()).error, /rate limit/);
  assert.equal(requests, 1);
  const another = await downloadFixture(root, async () => { throw new Error("Unexpected request during persisted cooldown"); }, state);
  assert.match((await another.download()).error, /rate limit/);
});

test("HTTP-date and Reddit reset headers set the shared cooldown", async () => {
  const until = Math.ceil((Date.now() + 240000) / 1000) * 1000;
  for (const headers of [{ "Retry-After": new Date(until).toUTCString() }, { "x-ratelimit-reset": "240" }]) {
    const { root } = buildPost();
    const { download, state } = await downloadFixture(root, async () => new Response("Limited", { status: 429, headers }));
    assert.match((await download()).error, /rate limit/);
    assert.ok(state.redditGrabFeedCooldown >= until - 1000);
  }
});

test("concurrent and later downloads reuse parsed JSON while each requested download still runs", async () => {
  const { root } = buildPost();
  let requests = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { download, jobs, state } = await downloadFixture(root, async () => {
    requests++;
    await pending;
    return Response.json([{ data: { children: [{ data: { id: "abc123", url: "https://i.redd.it/full.jpg" } }] } }]);
  });
  const first = download();
  const second = download();
  release();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  state.redditGrabFeedCooldown = Date.now() + 120000;
  assert.equal((await download()).ok, true);
  assert.equal(requests, 1);
  assert.equal(jobs.length, 3);
});

test("post identity uses stable attributes and canonical media URLs", async () => {
  const source = await readFile("content.js", "utf8");
  assert.match(source, /shreddit-post/);
  assert.match(source, /post-id/);
  assert.match(source, /thing-id/);
  assert.match(source, /replace\(\/\^t3_/);
  assert.doesNotMatch(source, /post-type/);
});
