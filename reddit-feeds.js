(function (root, factory) {
  if (root.RedditGrabFeeds) return;
  root.RedditGrabFeeds = factory();
})(globalThis, () => {
  "use strict";

  function targetFromUrl(value) {
    const url = new URL(value);
    if (!/(^|\.)reddit\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const [section, name, tab] = parts;
    if (!name || parts.length > 3) return null;
    if (section === "r" && /^[a-z0-9_]{2,21}$/i.test(name)) {
      if (/^(all|popular|friends|mod)$/i.test(name)) return null;
      if (tab && !["hot", "new", "top", "rising", "controversial", "about"].includes(tab)) return null;
      return { name, subredditName: name, label: `r/${name}`, kind: "community" };
    }
    if (["u", "user"].includes(section) && /^[a-z0-9_-]{3,20}$/i.test(name)) {
      if (tab && !["overview", "submitted", "comments", "saved", "upvoted", "downvoted", "hidden"].includes(tab)) return null;
      return { name, subredditName: `u_${name}`, label: `u/${name}`, kind: "profile" };
    }
    return null;
  }

  function contains(feed, target) {
    return feed.names.some((name) => name.toLowerCase() === target.subredditName.toLowerCase());
  }

  function createClient(fetcher = globalThis.fetch.bind(globalThis), storage = null) {
    let blockedUntil = 0;
    const verifiedFeedPaths = new Set();

    const cacheKey = "redditGrabFeedCache";
    const cooldownKey = "redditGrabFeedCooldown";
    let memory = null;
    let opening = null;
    let checkedUser = null;
    let checkingAccount = null;
    let authFailed = false;
    const reconciliation = new Map();

    async function stored(keys) {
      try { return storage ? await storage.get(keys) : {}; } catch { return {}; }
    }

    async function save(values) {
      try { await storage?.set(values); } catch { /* Keep this tab's memory cache usable. */ }
    }

    function feedKey(user, path) { return `redditGrabFeed:${user.toLowerCase()}:${path}`; }

    async function reconciliationMarkers(user, path) {
      const prefix = `${feedKey(user, path)}:needs-reconciliation:`;
      const entries = storage ? Object.entries(await storage.get(null)) : [...reconciliation];
      return entries.filter(([key, value]) => key.startsWith(prefix) && value)
        .map(([key, value]) => ({ ...value, key }));
    }

    async function markReconciliation(user, path, target) {
      const key = `${feedKey(user, path)}:needs-reconciliation:${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const marker = { key, community: target.subredditName, settled: false };
      reconciliation.set(key, marker);
      // A write must not proceed if its recovery checkpoint cannot be saved.
      await storage?.set({ [key]: marker });
      return marker;
    }

    async function settleReconciliation(marker) {
      const settled = { ...marker, settled: true };
      reconciliation.set(marker.key, settled);
      await storage?.set({ [marker.key]: settled });
    }

    async function clearReconciliation(markers, verifiedOwnKey) {
      for (const marker of markers) {
        // A read cannot settle another tab's queued or in-flight write.
        if (!marker.settled && marker.key !== verifiedOwnKey) continue;
        if (storage?.remove) await storage.remove(marker.key);
        else await storage?.set({ [marker.key]: null });
        reconciliation.delete(marker.key);
      }
    }

    async function cached() {
      const data = (await stored(cacheKey))[cacheKey] || memory;
      if (!data || typeof data.user !== "string" || !Number.isFinite(data.savedAt) || !Array.isArray(data.feeds)) return null;
      if (data.feeds.some(feed => typeof feed.path !== "string" || !Array.isArray(feed.names) ||
          feed.names.some(name => typeof name !== "string"))) return null;
      const result = structuredClone(data);
      const updates = await stored(result.feeds.map(feed => feedKey(result.user, feed.path)));
      result.feeds = result.feeds.map(feed => {
        const update = updates[feedKey(result.user, feed.path)];
        if (update?.savedAt >= result.savedAt && update.feed?.path === feed.path && Array.isArray(update.feed.names)) {
          verifiedFeedPaths.add(feed.path);
          result.updatedAt = Math.max(result.updatedAt || result.savedAt, update.savedAt);
          return update.feed;
        }
        return feed;
      });
      return result;
    }

    async function rememberFeed(user, feed) {
      const savedAt = Date.now();
      opening = null;
      verifiedFeedPaths.add(feed.path);
      if (memory?.user === user) {
        memory.feeds = memory.feeds.map(item => item.path === feed.path ? feed : item);
        memory.updatedAt = savedAt;
      }
      // Separate keys preserve simultaneous additions to different feeds in other tabs.
      await storage?.set({ [feedKey(user, feed.path)]: { savedAt, feed } });
    }

    async function request(path, options = {}) {
      blockedUntil = Math.max(blockedUntil, Number((await stored(cooldownKey))[cooldownKey]) || 0);
      if (Date.now() < blockedUntil) {
        const error = new Error("Reddit rate limit reached. Wait a few minutes before trying again.");
        error.transient = true;
        throw error;
      }
      let response;
      try { response = await fetcher(path, { credentials: "same-origin", cache: "no-store", ...options }); }
      catch (error) { error.transient = true; throw error; }
      if (response.status === 429) {
        const retry = response.headers.get("retry-after");
        const seconds = Number(retry || response.headers.get("x-ratelimit-reset"));
        const until = retry && !Number.isFinite(Number(retry)) ? Date.parse(retry) : Date.now() + seconds * 1000;
        blockedUntil = Math.max(Date.now() + 60000, Number.isFinite(until) ? until : 0);
        await save({ [cooldownKey]: blockedUntil });
        const error = new Error("Reddit rate limit reached. Wait a few minutes before trying again.");
        error.transient = true;
        throw error;
      }
      if ([401, 403].includes(response.status)) {
        const error = new Error("Sign in to Reddit and check that you can access this feed.");
        error.auth = true;
        authFailed = true;
        checkedUser = null;
        throw error;
      }
      if (!response.ok) {
        const error = new Error(`Reddit returned HTTP ${response.status}. Try again later.`);
        error.transient = response.status >= 500;
        throw error;
      }
      let data;
      try { data = await response.json(); } catch { throw new Error("Reddit returned an unexpected response. Refresh the page and sign in again."); }
      const errors = data?.json?.errors || data?.errors;
      if (data?.error || (Array.isArray(errors) && errors.length)) {
        if (JSON.stringify(errors || []).includes("RATELIMIT")) {
          blockedUntil = Date.now() + 60000;
          await save({ [cooldownKey]: blockedUntil });
        }
        const error = new Error(data?.message || errors?.[0]?.[1] || "Reddit could not update the feed.");
        error.transient = JSON.stringify(errors || []).includes("RATELIMIT");
        error.auth = [401, 403].includes(Number(data?.error));
        if (error.auth) { authFailed = true; checkedUser = null; }
        throw error;
      }
      return data;
    }

    async function account() {
      const result = await request("/api/me.json");
      const user = result?.data;
      if (!user?.name || !user.modhash) {
        const error = new Error("Sign in to Reddit to manage your custom feeds.");
        error.auth = true;
        authFailed = true;
        checkedUser = null;
        throw error;
      }
      checkedUser = { name: user.name, modhash: user.modhash };
      authFailed = false;
      return checkedUser;
    }

    function parseFeed(item, user) {
      const data = item?.data;
      const match = data?.path?.match(/^\/user\/([a-z0-9_-]+)\/m\/([a-z0-9_]+)\/?$/i);
      if (!match || match[1].toLowerCase() !== user.name.toLowerCase() || !Array.isArray(data.subreddits)) {
        throw new Error("Reddit returned an invalid custom feed.");
      }
      if (data.subreddits.some((entry) => typeof entry.name !== "string")) throw new Error("Reddit returned invalid feed membership.");
      if (typeof (data.display_name || data.name) !== "string") throw new Error("Reddit returned an invalid feed name.");
      return {
        path: data.path.replace(/\/$/, ""),
        label: data.display_name || data.name,
        visibility: data.visibility,
        editable: data.can_edit === true,
        names: data.subreddits.map((entry) => entry.name),
      };
    }

    async function fetchFeeds(target, knownUser) {
      const startedAt = Date.now();
      const user = knownUser || await account();
      const listing = await request("/api/multi/mine?raw_json=1");
      if (!Array.isArray(listing)) throw new Error("Reddit could not load your custom feeds.");
      const feeds = listing.map((item) => parseFeed(item, user)).filter((feed) => feed.editable);
      // The aggregate listing can lag behind a successful per-feed readback.
      // Recheck feeds changed in this tab rather than replacing verified state
      // with an older listing, or blindly assuming membership still exists.
      const previous = await cached();
      for (let i = 0; i < feeds.length; i++) {
        const path = feeds[i].path;
        const markers = await reconciliationMarkers(user.name, path);
        if (!markers.length && !verifiedFeedPaths.has(path)) continue;
        const known = previous?.user.toLowerCase() === user.name.toLowerCase() && previous.feeds.find(feed => feed.path === path);
        if (!markers.length && known && known.names.length === feeds[i].names.length &&
            known.names.every(name => feeds[i].names.some(current => current.toLowerCase() === name.toLowerCase()))) continue;
        const current = parseFeed(await request(`/api/multi${path}?raw_json=1`), user);
        if (current.path !== path) throw new Error("Reddit returned a different feed. Reopen the picker.");
        feeds[i] = current;
        await rememberFeed(user.name, current);
        await clearReconciliation(markers);
      }
      feeds.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
      memory = { user: user.name, feeds, savedAt: startedAt };
      await save({ [cacheKey]: memory });
      return await cached() || structuredClone(memory);
    }

    async function open(target, { refresh = false, cachedOnly = false } = {}) {
      const snapshot = await cached();
      if (cachedOnly) return !authFailed && snapshot || { user: null, feeds: [], cacheMissing: true };
      try {
        if (!refresh && snapshot) {
          if (!checkedUser) {
            checkingAccount ||= account().finally(() => { checkingAccount = null; });
            await checkingAccount;
          }
          if (checkedUser.name.toLowerCase() === snapshot.user.toLowerCase()) return snapshot;
        }
        if (opening) return await opening;
        const pending = fetchFeeds(target, snapshot && checkedUser?.name.toLowerCase() !== snapshot.user.toLowerCase() ? checkedUser : undefined)
          .finally(() => { if (opening === pending) opening = null; });
        opening = pending;
        return await pending;
      } catch (error) {
        if (!snapshot || authFailed || error.auth || !error.transient || (checkedUser && checkedUser.name.toLowerCase() !== snapshot.user.toLowerCase())) throw error;
        return { ...snapshot, warning: `Using saved feeds. ${error.message}` };
      }
    }

    async function add(session, path, target, isCurrent = () => true) {
      if (!session.feeds.some((feed) => feed.path === path && feed.editable)) throw new Error("Choose one of your editable custom feeds.");
      const user = await account();
      if (user.name.toLowerCase() !== session.user.toLowerCase()) {
        memory = null;
        await save({ [cacheKey]: null });
        throw new Error("Your Reddit account changed. Reload feeds for the current account.");
      }
      const snapshot = await cached();
      const known = snapshot?.user.toLowerCase() === user.name.toLowerCase() && snapshot.feeds.find(feed => feed.path === path);
      const previousMarkers = await reconciliationMarkers(user.name, path);
      const current = !previousMarkers.length && known || parseFeed(await request(`/api/multi${path}?raw_json=1`), user);
      if (current.path !== path) throw new Error("Reddit returned a different feed. Reopen the picker.");
      if (!current.editable) throw new Error("You can no longer edit this feed.");
      if (previousMarkers.length) {
        await rememberFeed(user.name, current);
        await clearReconciliation(previousMarkers);
      }
      if (contains(current, target)) {
        await rememberFeed(user.name, current);
        return { feed: current, alreadyPresent: true };
      }
      if (current.names.length >= 100) throw new Error("This feed is full. Choose another feed.");
      if (!isCurrent()) throw new Error("The page changed. Open the picker on the page you want to add.");
      const marker = await markReconciliation(user.name, path, target);
      if (!isCurrent()) {
        await clearReconciliation([marker], marker.key);
        throw new Error("The page changed. Open the picker on the page you want to add.");
      }
      try {
        await request(`/api/multi${path}/r/${encodeURIComponent(target.subredditName)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Modhash": user.modhash },
          body: new URLSearchParams({ api_type: "json", model: JSON.stringify({ name: target.subredditName }) }),
        });
      } catch (error) {
        await settleReconciliation(marker).catch(() => {});
        throw new Error(`${error.message} The add was not confirmed. Try again to check membership first.`);
      }
      let verified;
      try {
        verified = parseFeed(await request(`/api/multi${path}?raw_json=1`), user);
        if (verified.path !== path || !contains(verified, target)) throw new Error("Membership not found.");
      } catch {
        await settleReconciliation(marker).catch(() => {});
        throw new Error("The add was sent, but could not be verified. Try again to check membership before adding.");
      }
      try {
        await rememberFeed(user.name, verified);
        await clearReconciliation([marker], marker.key);
      } catch (error) {
        await settleReconciliation(marker).catch(() => {});
        throw error;
      }
      return { feed: verified, alreadyPresent: false };
    }

    return { open, add };
  }

  return { targetFromUrl, contains, createClient };
});
