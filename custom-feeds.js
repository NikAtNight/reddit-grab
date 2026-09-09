(() => {
  "use strict";
  if (globalThis.__redditGrabFeedsLoaded || window.top !== window) return;
  if (!globalThis.RedditGrabFeeds) return;
  globalThis.__redditGrabFeedsLoaded = true;

  const { targetFromUrl, contains, createClient } = globalThis.RedditGrabFeeds;
  const client = createClient();
  const host = document.createElement("div");
  host.id = "reddit-grab-custom-feeds";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; position: fixed; right: max(20px, env(safe-area-inset-right));
      bottom: max(20px, env(safe-area-inset-bottom)); z-index: 2147483646;
      font: 14px/1.45 system-ui, sans-serif; color-scheme: light dark;
      --surface: #fff; --text: #18212a; --muted: #576572; --border: #d4dce2; --hover: #edf3f7;
      color: var(--text); }
    :host([hidden]), [hidden] { display: none !important; }
    * { box-sizing: border-box; }
    button, input { font: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: default; opacity: .6; }
    button:focus-visible, input:focus-visible { outline: 3px solid #2979d8; outline-offset: 2px; }
    #launcher { display: flex; gap: 8px; align-items: center; margin-left: auto; border: 0;
      border-radius: 24px; padding: 12px 18px; background: #d93900; color: #fff;
      font-weight: 650; box-shadow: 0 4px 18px #0003; }
    #launcher:hover { background: #b83100; }
    #launcher[data-member="true"] { background: #187044; }
    #launcher[data-member="true"]:hover { background: #125735; }
    #panel { width: min(350px, calc(100vw - 40px)); max-height: calc(100dvh - 110px);
      overflow: auto; margin-bottom: 12px; padding: 16px; border: 1px solid var(--border);
      border-radius: 16px; background: var(--surface); box-shadow: 0 8px 32px #0003; }
    header { display: flex; align-items: flex-start; gap: 12px; }
    h2 { font-size: 16px; margin: 0; }
    #target { margin: 4px 0 12px; color: var(--muted); overflow-wrap: anywhere; }
    #close { margin-left: auto; border: 0; background: transparent; color: var(--text);
      padding: 2px 8px; font-size: 22px; line-height: 1; border-radius: 6px; }
    #search { width: 100%; padding: 10px; margin-bottom: 10px; border-radius: 8px;
      border: 1px solid var(--border); color: var(--text); background: var(--surface); }
    #feeds { display: grid; gap: 6px; max-height: 280px; overflow: auto; padding: 3px; }
    .feed { display: flex; justify-content: space-between; gap: 12px; width: 100%;
      text-align: left; padding: 10px; border: 1px solid var(--border); border-radius: 10px;
      background: var(--surface); color: var(--text); }
    .feed:hover:not(:disabled) { background: var(--hover); }
    .name { font-weight: 600; overflow-wrap: anywhere; }
    .meta { display: block; color: var(--muted); font-size: 12px; }
    .action { align-self: center; white-space: nowrap; font-size: 12px; }
    #status { margin: 10px 0 0; overflow-wrap: anywhere; }
    #retry { margin-top: 10px; padding: 6px 12px; border: 1px solid var(--border);
      border-radius: 8px; color: var(--text); background: var(--surface); }
    @media (prefers-color-scheme: dark) {
      :host { --surface: #182026; --text: #eef3f7; --muted: #aebbc5; --border: #43515c; --hover: #26343e; }
    }
  `;
  root.append(style);

  function element(tag, text, parent) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    parent?.append(node);
    return node;
  }
  function button(text, parent) {
    const node = element("button", text, parent);
    node.type = "button";
    return node;
  }

  const panel = element("section", "", root);
  panel.id = "panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-labelledby", "heading");
  const header = element("header", "", panel);
  element("h2", "Add to custom feed", header).id = "heading";
  const close = button("×", header);
  close.id = "close";
  close.setAttribute("aria-label", "Close feed picker");
  const targetLabel = element("p", "", panel);
  targetLabel.id = "target";
  const search = element("input", "", panel);
  search.id = "search";
  search.type = "search";
  search.placeholder = "Find a custom feed";
  search.setAttribute("aria-label", "Find a custom feed");
  const list = element("div", "", panel);
  list.id = "feeds";
  const status = element("p", "", panel);
  status.id = "status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const retry = button("Reload feeds", panel);
  retry.id = "retry";
  retry.hidden = true;
  const launcher = button("＋ Add to feed", root);
  launcher.id = "launcher";
  launcher.setAttribute("aria-haspopup", "dialog");
  launcher.setAttribute("aria-controls", "panel");
  launcher.setAttribute("aria-expanded", "false");

  let target = null;
  let pickerTarget = null;
  let pickerOpener = null;
  let session = null;
  let generation = 0;
  let busy = false;
  let loading = false;
  let membership = null;
  let membershipError = "";
  let lookup = null;
  let lookupTimer;
  let currentUrl = null;

  // This snapshot belongs to the current page lookup, not the migration inventory.
  let feedNames = new Set();
  const hiddenJoins = new Map();
  const observedRoots = new Set();
  let joinTimer;
  const joinObserver = new MutationObserver(() => {
    clearTimeout(joinTimer);
    joinTimer = setTimeout(updatePostJoins, 100);
  });

  function postCommunity(post) {
    const name = (post?.getAttribute("subreddit-name") ||
      post?.getAttribute("subreddit-prefixed-name")?.replace(/^r\//i, "") || "").toLowerCase();
    return /^[a-z0-9_]{2,21}$/i.test(name) ? name : null;
  }

  function updatePostJoins() {
    const matching = new Map();
    const roots = new Set([document]);
    function inspect(container, community) {
      for (const node of container.children) {
        if (node.matches("shreddit-post")) continue;
        if (node.matches('shreddit-join-button, button[data-post-click-location="join"]')) {
          const control = node.shadowRoot?.querySelector("button") || node;
          const subscribed = node.getAttribute("is-subscribed");
          if (subscribed !== "true" && subscribed !== "" && !/^joined$/i.test(control.textContent.trim())) {
            matching.set(node, community);
          }
          continue;
        }
        inspect(node, community);
        if (node.shadowRoot) {
          roots.add(node.shadowRoot);
          inspect(node.shadowRoot, community);
        }
      }
    }
    for (const post of document.querySelectorAll("shreddit-post")) {
      const name = postCommunity(post);
      if (!name) continue;
      inspect(post, name);
      if (post.shadowRoot) {
        roots.add(post.shadowRoot);
        inspect(post.shadowRoot, name);
      }
    }
    for (const [node, previous] of hiddenJoins) {
      if (matching.has(node)) continue;
      if (previous.value) node.style.setProperty("display", previous.value, previous.priority);
      else node.style.removeProperty("display");
      previous.replacement.remove();
      hiddenJoins.delete(node);
    }
    for (const [node, community] of matching) {
      if (!hiddenJoins.has(node)) {
        const replacement = button("Add to feed");
        replacement.dataset.redditGrabPostFeed = "";
        replacement.style.cssText = "position:relative;z-index:1;border:0;border-radius:20px;padding:5px 12px;background:#d93900;color:white;font:600 12px/20px system-ui;cursor:pointer;white-space:nowrap";
        replacement.setAttribute("aria-haspopup", "dialog");
        hiddenJoins.set(node, {
          value: node.style.getPropertyValue("display"), priority: node.style.getPropertyPriority("display"),
          replacement,
        });
      }
      const { replacement } = hiddenJoins.get(node);
      replacement.dataset.community = community;
      replacement.setAttribute("aria-label", `Add r/${community} to a custom feed`);
      if (node.hasAttribute("slot")) replacement.setAttribute("slot", node.getAttribute("slot"));
      else replacement.removeAttribute("slot");
      replacement.hidden = feedNames.has(community);
      // Reddit sets button display explicitly, overriding the native hidden rule.
      replacement.style.setProperty("display", replacement.hidden ? "none" : "inline-block", "important");
      if (replacement.previousSibling !== node) {
        const redrawn = node.nextElementSibling;
        if (redrawn?.matches("button[data-reddit-grab-post-feed]")) redrawn.remove();
        node.after(replacement);
      }
      node.style.setProperty("display", "none", "important");
    }
    if (roots.size !== observedRoots.size || [...roots].some(root => !observedRoots.has(root))) {
      joinObserver.disconnect();
      observedRoots.clear();
      for (const root of roots) {
        observedRoots.add(root);
        joinObserver.observe(root, { childList: true, subtree: true, attributes: true,
          attributeFilter: ["subreddit-name", "subreddit-prefixed-name", "data-post-click-location", "is-subscribed"] });
      }
    }
  }

  function updateFeedNames(feeds = []) {
    feedNames = new Set(feeds.flatMap(feed => feed.names.map(name => name.toLowerCase())));
    updatePostJoins();
  }

  function renderLauncher() {
    const count = membership?.length || 0;
    launcher.dataset.member = String(count > 0);
    launcher.textContent = membership === null
      ? membershipError ? "? Check feed status" : "Checking feeds…"
      : count ? `✓ In ${count} ${count === 1 ? "feed" : "feeds"}` : "＋ Add to feed";
    launcher.title = membership === null
      ? membershipError || "Checking your custom feeds"
      : count ? `Already in: ${membership.map((feed) => feed.label).join(", ")}` : "Not in any of your custom feeds";
    launcher.setAttribute("aria-label", `${target?.label || "Current page"}: ${launcher.textContent}. ${launcher.title}. Open feed picker`);
  }

  function loadMembership(selected) {
    clearTimeout(lookupTimer);
    if (lookup && lookup.label === (selected?.label || null)) return lookup.promise;
    membershipError = "";
    renderLauncher();
    const job = { label: selected?.label || null, url: location.href };
    lookup = job;
    job.promise = client.open(selected).then((result) => {
      if (lookup === job && location.href === job.url) {
        updateFeedNames(result.feeds);
        membership = target ? result.feeds.filter((feed) => contains(feed, target)) : [];
        renderLauncher();
      }
      return result;
    }).catch((error) => {
      if (lookup === job && location.href === job.url) {
        membership = null;
        membershipError = error.message;
        updateFeedNames();
        renderLauncher();
      }
      throw error;
    }).finally(() => {
      if (lookup === job) lookup = null;
    });
    return job.promise;
  }

  function closePanel(focus = true) {
    panel.hidden = true;
    pickerTarget = null;
    host.hidden = !target;
    launcher.setAttribute("aria-expanded", "false");
    generation++;
    if (focus) {
      if (pickerOpener?.isConnected && !pickerOpener.hidden) pickerOpener.focus();
      else if (!host.hidden) launcher.focus();
    }
    pickerOpener = null;
  }

  function renderFeeds() {
    list.replaceChildren();
    search.disabled = loading;
    retry.disabled = busy || loading;
    if (!session || !pickerTarget) return;
    const query = search.value.trim().toLowerCase();
    const feeds = session.feeds.filter((feed) => feed.label.toLowerCase().includes(query));
    for (const feed of feeds) {
      const present = contains(feed, pickerTarget);
      const full = feed.names.length >= 100;
      const row = button("", list);
      row.className = "feed";
      const label = element("span", "", row);
      element("span", feed.label, label).className = "name";
      element("span", `${feed.visibility} · ${feed.names.length}/100`, label).className = "meta";
      element("span", present ? "Added ✓" : full ? "Full" : "Add +", row).className = "action";
      row.disabled = busy || loading || present || full;
      row.setAttribute("aria-label", `${present ? "Already in" : "Add to"} ${feed.label}, ${feed.visibility}${full ? ", full" : ""}`);
      row.addEventListener("click", () => add(feed));
    }
    if (!feeds.length) element("p", session.feeds.length ? "No matching feeds." : "No custom feeds yet. Create one in Reddit's Custom Feeds section, then reload here.", list);
  }

  async function openPanel(selected, opener) {
    syncTarget();
    selected ||= pickerTarget || target;
    opener ||= pickerOpener;
    if (!selected) return;
    pickerTarget = selected;
    pickerOpener = opener;
    host.hidden = false;
    const ticket = ++generation;
    panel.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    targetLabel.textContent = selected.label;
    search.value = "";
    session = null;
    loading = true;
    retry.hidden = true;
    status.textContent = "Loading your feeds…";
    renderFeeds();
    close.focus();
    try {
      const result = await loadMembership(selected);
      if (ticket !== generation) return;
      session = result;
      status.textContent = busy ? "Finishing the previous add…" : "Choose a feed to add this " + selected.kind + ".";
    } catch (error) {
      if (ticket === generation) status.textContent = error.message;
    } finally {
      if (ticket === generation) {
        loading = false;
        retry.hidden = false;
        renderFeeds();
        if (session) search.focus();
      }
    }
  }

  async function add(feed) {
    syncTarget();
    if (busy || loading || !session || !pickerTarget) return;
    const selected = pickerTarget;
    const url = location.href;
    const ticket = generation;
    const currentSession = session;
    const isCurrent = () => ticket === generation && location.href === url && pickerTarget?.label === selected.label;
    busy = true;
    status.textContent = `Adding ${selected.label} to ${feed.label}…`;
    renderFeeds();
    try {
      const result = await client.add(currentSession, feed.path, selected, isCurrent);
      if (location.href === url) {
        // A picker opened during the write may have read the old membership.
        lookup = null;
        const updatedFeeds = currentSession.feeds.map(item => item.path === feed.path ? result.feed : item);
        membership = target ? updatedFeeds.filter(item => contains(item, target)) : [];
        membershipError = "";
        updateFeedNames(updatedFeeds);
        renderLauncher();
      }
      if (!isCurrent()) return;
      session.feeds = session.feeds.map((item) => item.path === feed.path ? result.feed : item);
      status.textContent = `${selected.label} ${result.alreadyPresent ? "is already in" : "was added to"} ${feed.label}.`;
    } catch (error) {
      if (location.href === url) {
        lookup = null;
        membership = null;
        membershipError = error.message;
        updateFeedNames();
        renderLauncher();
      }
      if (isCurrent()) status.textContent = error.message;
    } finally {
      busy = false;
      if (!isCurrent() && !panel.hidden && pickerTarget) {
        await openPanel();
      } else {
        renderFeeds();
        if (isCurrent()) search.focus();
      }
    }
  }

  function syncTarget() {
    const next = targetFromUrl(location.href);
    if (next?.label !== target?.label || currentUrl !== location.href) {
      currentUrl = location.href;
      closePanel(false);
      session = null;
      target = next;
      updateFeedNames();
      membership = null;
      membershipError = "";
      lookup = null;
      clearTimeout(lookupTimer);
      host.hidden = !target;
      renderLauncher();
      // Posts need the feed list even on pages with no floating launcher.
      const selected = target;
      lookupTimer = setTimeout(() => {
        loadMembership(selected).catch(() => {});
      }, 350);
    }
    if (!host.isConnected && document.body) document.body.append(host);
  }

  function refreshMembership() {
    syncTarget();
    if (busy || loading || document.hidden) return;
    clearTimeout(lookupTimer);
    const selected = target;
    const url = location.href;
    lookupTimer = setTimeout(() => {
      if (location.href !== url || busy || loading) return;
      if (panel.hidden) loadMembership(selected).catch(() => {});
      else openPanel();
    }, 350);
  }

  // Capture before Reddit's post handlers; delegation survives replaced buttons.
  document.addEventListener("click", (event) => {
    const path = event.composedPath();
    const replacement = path.find(node => node?.matches?.("button[data-reddit-grab-post-feed]"));
    if (!replacement) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const post = path.find(node => node?.matches?.("shreddit-post"));
    const name = postCommunity(post);
    if (!name || !replacement.isConnected) return;
    syncTarget();
    updatePostJoins();
    if (feedNames.has(name)) return;
    openPanel({ name, subredditName: name, label: `r/${name}`, kind: "community" }, replacement);
  }, true);

  launcher.addEventListener("click", () => {
    syncTarget();
    if (panel.hidden) openPanel(target);
    else closePanel();
  });
  close.addEventListener("click", () => closePanel());
  retry.addEventListener("click", () => openPanel());
  search.addEventListener("input", renderFeeds);
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.stopPropagation(); closePanel(); }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!panel.hidden && !event.composedPath().includes(host)) closePanel(false);
  });
  window.addEventListener("popstate", syncTarget);
  window.addEventListener("focus", refreshMembership);
  document.addEventListener("visibilitychange", refreshMembership);
  launcher.addEventListener("pointerenter", refreshMembership);
  // pushState navigation is not visible to isolated content-script history hooks.
  // Checking the URL also repairs the widget if Reddit replaces its container.
  host.hidden = true;
  syncTarget();
  setInterval(syncTarget, 500);
  // Attaching a shadow root alone does not produce a DOM mutation.
  setInterval(updatePostJoins, 2000);
})();
