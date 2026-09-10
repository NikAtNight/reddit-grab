(function (root, factory) {
  if (root.RedditGrabRequests) return;
  root.RedditGrabRequests = factory();
})(globalThis, () => {
  "use strict";
  const cooldownKey = "redditGrabFeedCooldown";

  function validate(request) {
    const origin = new URL(request.origin);
    if (origin.protocol !== "https:" || !/(^|\.)reddit\.com$/i.test(origin.hostname) || origin.origin !== request.origin) {
      throw new Error("Invalid Reddit request origin");
    }
    const url = new URL(request.path, origin);
    if (url.origin !== origin.origin || url.username || url.password) throw new Error("Invalid Reddit request URL");
    const method = request.method || "GET";
    const feed = /^\/api\/multi\/user\/[a-z0-9_-]+\/m\/[a-z0-9_]+(?:\/r\/([a-z0-9_-]+))?$/i.exec(url.pathname);
    const read = url.pathname === "/api/me.json" || url.pathname === "/api/multi/mine" ||
      (feed && !feed[1]) || /^\/(?:(?:r\/[a-z0-9_]+|(?:user|u)\/[a-z0-9_-]+)\/)?comments\/[a-z0-9]+(?:\/[^?#]*)?\.json$/i.test(url.pathname);
    if (method === "GET" && read) return { ...request, method, path: url.pathname + url.search };
    if (method === "PUT" && feed?.[1] && typeof request.body === "string" && request.body.length < 4096) {
      const form = new URLSearchParams(request.body);
      const model = JSON.parse(form.get("model") || "null");
      if (model?.name?.toLowerCase() !== feed[1].toLowerCase() || form.get("api_type") !== "json") throw new Error("Invalid feed member request");
      return { ...request, method, path: url.pathname + url.search };
    }
    throw new Error("Unsupported Reddit request");
  }

  function createBroker({ execute, storage, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), spacing = 1500 }) {
    const waiting = [];
    const reads = new Map();
    let running = false;
    let lastRequestAt = 0;
    let blockedUntil = 0;
    const ready = (async () => {
      try {
        const previous = (await storage?.get("redditGrabRequestStatus"))?.redditGrabRequestStatus;
        lastRequestAt = Math.min(now(), Math.max(0, Number(previous?.lastRequestAt) || 0));
      } catch { /* Start a new pacing window if storage is unavailable. */ }
      await status();
    })();
    async function save(values) { try { await storage?.set(values); } catch { /* In-memory pacing still applies. */ } }
    async function cooldown() {
      try { blockedUntil = Math.max(blockedUntil, Number((await storage?.get(cooldownKey))?.[cooldownKey]) || 0); } catch { /* Use memory. */ }
      return blockedUntil;
    }
    async function status(inFlight = 0) {
      await save({ redditGrabRequestStatus: { queued: waiting.length, inFlight, lastRequestAt } });
    }
    function limited() {
      return { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil((blockedUntil - now()) / 1000))) },
        body: JSON.stringify({ message: "Reddit requests are paused until the cooldown ends. Retry explicitly later." }) };
    }
    async function drain() {
      if (running) return;
      running = true;
      try {
        await ready;
        while (waiting.length) {
          const item = waiting.shift();
          try {
            await cooldown();
            if (now() < blockedUntil) { item.resolve(limited()); continue; }
            const delay = lastRequestAt ? Math.max(0, spacing - (now() - lastRequestAt)) : 0;
            if (delay) await sleep(delay);
            await cooldown();
            if (now() < blockedUntil) { item.resolve(limited()); continue; }
            lastRequestAt = now();
            await status(1);
            const response = await execute(item.request, item.context);
            if (!response || !Number.isInteger(response.status) || typeof response.body !== "string") throw new Error("Reddit tab returned an invalid response");
            const headers = response.headers || {};
            let rateError = response.status === 429;
            try {
              const json = JSON.parse(response.body);
              rateError ||= JSON.stringify(json?.json?.errors || json?.errors || []).includes("RATELIMIT");
            } catch { /* Non-JSON responses are handled by the caller. */ }
            if (rateError || (headers["x-ratelimit-remaining"] !== undefined && Number(headers["x-ratelimit-remaining"]) <= 0)) {
              const retry = headers["retry-after"];
              const seconds = Number(retry || headers["x-ratelimit-reset"]);
              const until = retry && !Number.isFinite(Number(retry)) ? Date.parse(retry) : now() + seconds * 1000;
              blockedUntil = Math.max(blockedUntil, now() + 60000, Number.isFinite(until) ? until : 0);
              await save({ [cooldownKey]: blockedUntil });
            }
            item.resolve(response);
          } catch (error) { item.reject(error); }
          finally { if (item.key) reads.delete(item.key); await status(); }
        }
      } finally { running = false; }
    }
    function enqueue(raw, context) {
      const request = validate(raw);
      // Per-feed reads verify writes and must not share an earlier pre-write read.
      const share = request.method === "GET" && !request.path.startsWith("/api/multi/user/");
      const key = share ? `${context.scope}:${request.origin}:${request.path}` : null;
      if (key && reads.has(key)) return reads.get(key);
      if (waiting.length >= 30) return Promise.reject(new Error("Reddit request queue is full. Try again after current requests finish."));
      const promise = new Promise((resolve, reject) => waiting.push({ request, context, key, resolve, reject }));
      if (key) reads.set(key, promise);
      void drain();
      return promise;
    }
    return { enqueue };
  }

  const api = globalThis.browser || globalThis.chrome;
  if (typeof document !== "undefined" && api?.runtime?.onMessage) {
    api.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.type !== "reddit-grab-execute-request" || sender.id !== api.runtime.id) return undefined;
      (async () => {
        const request = validate(message.request);
        if (request.origin !== location.origin || (request.method !== "GET" && request.pageUrl !== location.href)) {
          throw new Error("The Reddit page changed before the request started");
        }
        const headers = {};
        if (request.method === "PUT") {
          const modhash = request.headers?.["X-Modhash"];
          if (typeof modhash !== "string" || modhash.length > 512) throw new Error("Invalid Reddit session header");
          headers["X-Modhash"] = modhash;
          headers["Content-Type"] = "application/x-www-form-urlencoded";
        }
        const response = await fetch(request.origin + request.path, { method: request.method, credentials: "same-origin", cache: "no-store",
          headers, ...(request.method === "PUT" ? { body: request.body } : {}), signal: AbortSignal.timeout(20000) });
        const body = await response.text();
        if (body.length > 8 * 1024 * 1024) throw new Error("Reddit response was too large");
        return { status: response.status, body, headers: Object.fromEntries(response.headers.entries()) };
      })().then(value => respond({ ok: true, value }), error => respond({ ok: false, error: error.message }));
      return true;
    });
  }

  async function queuedFetch(value, options = {}) {
    const url = new URL(value, location.origin);
    const request = validate({ origin: location.origin, path: url.href, pageUrl: location.href,
      method: options.method || "GET", headers: options.headers, body: options.body?.toString() });
    const response = await api.runtime.sendMessage({ type: "reddit-grab-request", request });
    if (!response?.ok) throw new Error(response?.error || "Reddit request coordinator is unavailable. Reload the extension and page.");
    const { body, status, headers } = response.value;
    return new Response([204, 205, 304].includes(status) ? null : body, { status, headers });
  }
  return { createBroker, validate, fetch: queuedFetch };
});
