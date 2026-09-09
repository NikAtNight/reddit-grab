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

  function createClient(fetcher = globalThis.fetch.bind(globalThis)) {
    let blockedUntil = 0;
    const verifiedFeedPaths = new Set();

    async function request(path, options = {}) {
      if (Date.now() < blockedUntil) throw new Error("Reddit rate limit reached. Wait a few minutes before trying again.");
      const response = await fetcher(path, { credentials: "same-origin", cache: "no-store", ...options });
      if (response.status === 429) {
        const retry = response.headers.get("retry-after");
        const seconds = Number(retry || response.headers.get("x-ratelimit-reset"));
        const until = retry && !Number.isFinite(Number(retry)) ? Date.parse(retry) : Date.now() + seconds * 1000;
        blockedUntil = Math.max(Date.now() + 60000, Number.isFinite(until) ? until : 0);
        throw new Error("Reddit rate limit reached. Wait a few minutes before trying again.");
      }
      if ([401, 403].includes(response.status)) throw new Error("Sign in to Reddit and check that you can access this feed.");
      if (!response.ok) throw new Error(`Reddit returned HTTP ${response.status}. Try again later.`);
      let data;
      try { data = await response.json(); } catch { throw new Error("Reddit returned an unexpected response. Refresh the page and sign in again."); }
      const errors = data?.json?.errors || data?.errors;
      if (data?.error || (Array.isArray(errors) && errors.length)) {
        if (JSON.stringify(errors).includes("RATELIMIT")) blockedUntil = Date.now() + 60000;
        throw new Error(data?.message || errors?.[0]?.[1] || "Reddit could not update the feed.");
      }
      return data;
    }

    async function account() {
      const result = await request("/api/me.json");
      const user = result?.data;
      if (!user?.name || !user.modhash) throw new Error("Sign in to Reddit to manage your custom feeds.");
      return { name: user.name, modhash: user.modhash };
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

    async function open(target) {
      const user = await account();
      if (target) {
        const info = await request(`/api/info.json?raw_json=1&sr_name=${encodeURIComponent(target.subredditName)}`);
        const community = info?.data?.children?.find((item) => item.data?.display_name?.toLowerCase() === target.subredditName.toLowerCase())?.data;
        if (!community?.name?.startsWith("t5_")) throw new Error("This profile or community is unavailable for custom feeds.");
      }
      const listing = await request("/api/multi/mine?raw_json=1");
      if (!Array.isArray(listing)) throw new Error("Reddit could not load your custom feeds.");
      const feeds = listing.map((item) => parseFeed(item, user)).filter((feed) => feed.editable);
      // The aggregate listing can lag behind a successful per-feed readback.
      // Recheck feeds changed in this tab rather than replacing verified state
      // with an older listing, or blindly assuming membership still exists.
      for (let i = 0; i < feeds.length; i++) {
        if (!verifiedFeedPaths.has(feeds[i].path)) continue;
        const path = feeds[i].path;
        const current = parseFeed(await request(`/api/multi${path}?raw_json=1`), user);
        if (current.path !== path) throw new Error("Reddit returned a different feed. Reopen the picker.");
        feeds[i] = current;
      }
      feeds.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
      return { user: user.name, feeds };
    }

    async function add(session, path, target, isCurrent = () => true) {
      if (!session.feeds.some((feed) => feed.path === path && feed.editable)) throw new Error("Choose one of your editable custom feeds.");
      const user = await account();
      if (user.name.toLowerCase() !== session.user.toLowerCase()) throw new Error("Your Reddit account changed. Reopen the feed picker.");
      const current = parseFeed(await request(`/api/multi${path}?raw_json=1`), user);
      if (current.path !== path) throw new Error("Reddit returned a different feed. Reopen the picker.");
      if (!current.editable) throw new Error("You can no longer edit this feed.");
      if (contains(current, target)) {
        verifiedFeedPaths.add(path);
        return { feed: current, alreadyPresent: true };
      }
      if (current.names.length >= 100) throw new Error("This feed is full. Choose another feed.");
      if (!isCurrent()) throw new Error("The page changed. Open the picker on the page you want to add.");
      try {
        await request(`/api/multi${path}/r/${encodeURIComponent(target.subredditName)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Modhash": user.modhash },
          body: new URLSearchParams({ api_type: "json", model: JSON.stringify({ name: target.subredditName }) }),
        });
      } catch (error) {
        throw new Error(`${error.message} The add was not confirmed. Try again to check membership first.`);
      }
      let verified;
      try {
        verified = parseFeed(await request(`/api/multi${path}?raw_json=1`), user);
        if (verified.path !== path || !contains(verified, target)) throw new Error("Membership not found.");
      } catch {
        throw new Error("The add was sent, but could not be verified. Try again to check membership before adding.");
      }
      verifiedFeedPaths.add(path);
      return { feed: verified, alreadyPresent: false };
    }

    return { open, add };
  }

  return { targetFromUrl, contains, createClient };
});
