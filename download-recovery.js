(function (root) {
  "use strict";
  if (root.RedditGrabRecovery) return;

  const KEY = "redditGrabDownloadRecovery";
  const LIMIT = 100;

  function cleanUrl(value, post = false) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) return null;
      if (post && (!/(^|\.)reddit\.com$/i.test(url.hostname) || !/\/comments\/[a-z0-9]+(?:\/|$)/i.test(url.pathname))) return null;
      if (post) { url.search = ""; url.hash = ""; }
      return url.href;
    } catch { return null; }
  }

  function cleanJob(job, item) {
    if (!item || !["direct", "reddit-video", "external", "post"].includes(item.kind)) throw new Error("This download cannot be saved for retry.");
    const result = { kind: item.kind };
    for (const key of ["url", "videoUrl", "dashUrl", "sourceUrl"]) {
      if (!item[key]) continue;
      const value = cleanUrl(item[key], item.kind === "post");
      if (!value) throw new Error("This download has an invalid source URL.");
      result[key] = value;
    }
    for (const key of ["audio", "suffix", "ext", "extHint", "provider", "id"]) {
      if (typeof item[key] === "string") result[key] = item[key].slice(0, 200);
    }
    if (item.kind === "post" && !result.url) throw new Error("A Reddit post URL is required.");
    const sourceTab = job?.sourceTab;
    return {
      postId: String(job?.postId || "post").slice(0, 100),
      subreddit: String(job?.subreddit || "reddit").slice(0, 100),
      items: [result],
      ...(item.kind === "post" && Number.isInteger(sourceTab?.id) ? { sourceTab: {
        id: sourceTab.id, incognito: sourceTab.incognito === true,
        ...(typeof sourceTab.cookieStoreId === "string" ? { cookieStoreId: sourceTab.cookieStoreId } : {}),
      } } : {}),
    };
  }

  function errorText(error) {
    return String(error?.message || error || "Download interrupted")
      .replace(/https?:\/\/\S+/g, "[media URL]")
      .replace(/Bearer\s+\S+/gi, "[credential]")
      .slice(0, 400);
  }

  function create({ storage, retry: runRetry }) {
    let records = [];
    let transfers = [];
    let sequence = Promise.resolve();
    const retrying = new Set();
    const ready = (async () => {
      const data = (await storage.get(KEY))?.[KEY];
      for (const entry of Array.isArray(data?.records) ? data.records : []) {
        try {
          if (typeof entry.id !== "string") continue;
          records.push({ id: entry.id, job: cleanJob(entry.job, entry.job?.items?.[0]), error: errorText(entry.error),
            status: ["retrying", "downloading"].includes(entry.status) ? entry.status : "failed",
            createdAt: Number(entry.createdAt) || Date.now(), updatedAt: Number(entry.updatedAt) || Date.now(),
            attempts: Number(entry.attempts) || 0 });
        } catch { /* Ignore obsolete or malformed saved records. */ }
      }
      for (const entry of Array.isArray(data?.transfers) ? data.transfers : []) {
        try {
          if (!Number.isInteger(entry.id)) continue;
          transfers.push({ id: entry.id, recoveryId: entry.recoveryId || null, job: cleanJob(entry.job, entry.job?.items?.[0]) });
        } catch { /* A malformed transfer cannot be retried safely. */ }
      }
      records = records.slice(-LIMIT);
      transfers = transfers.slice(-500);
      for (const entry of records) {
        if (entry.status === "retrying" && !transfers.some(item => item.recoveryId === entry.id)) {
          entry.status = "failed";
          entry.error = "The previous retry did not finish. Check the browser's downloads before retrying.";
        }
      }
    })();

    function change(action, persist = true) {
      const next = sequence.then(async () => {
        await ready;
        const result = await action();
        if (persist) await storage.set({ [KEY]: { records, transfers } });
        return result;
      });
      sequence = next.catch(() => {});
      return next;
    }

    function failed(job, error, recoveryId) {
      let entry = records.find(item => recoveryId ? item.id === recoveryId : item.status === "failed" && JSON.stringify(item.job) === JSON.stringify(job));
      // A mux retry can fail as separate video/audio downloads. Retain each
      // failed stream without putting an already successful stream back.
      if (entry?.status === "failed" && JSON.stringify(entry.job) !== JSON.stringify(job)) {
        entry = records.find(item => item.status === "failed" && JSON.stringify(item.job) === JSON.stringify(job));
      }
      if (!entry) {
        entry = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, job, createdAt: Date.now(), attempts: 0 };
        records.push(entry);
        if (records.length > LIMIT) {
          const oldest = records.findIndex(item => item.id !== entry.id && item.status === "failed");
          records.splice(oldest < 0 ? 0 : oldest, 1);
        }
      }
      entry.job = job;
      entry.status = "failed";
      entry.error = errorText(error);
      entry.updatedAt = Date.now();
      return entry.id;
    }

    async function recordFailure(job, item, error, recoveryId) {
      const source = cleanJob(job, item);
      return change(() => failed(source, error, recoveryId));
    }

    async function recordStarted(downloadId, job, item, recoveryId) {
      if (!Number.isInteger(downloadId)) throw new Error("Invalid browser download ID.");
      const source = cleanJob(job, item);
      return change(() => {
        transfers = transfers.filter(entry => entry.id !== downloadId);
        transfers.push({ id: downloadId, recoveryId: recoveryId || null, job: source });
        transfers = transfers.slice(-500);
        const entry = records.find(record => record.id === recoveryId);
        if (entry && entry.status !== "failed") entry.status = "downloading";
      });
    }

    async function changed({ id, state, error }) {
      if (!["complete", "interrupted"].includes(state?.current)) return;
      return change(() => {
        const transfer = transfers.find(entry => entry.id === id);
        if (!transfer) return;
        transfers = transfers.filter(entry => entry.id !== id);
        if (state.current === "interrupted") {
          failed(transfer.job, error?.current || "Browser download interrupted", transfer.recoveryId);
        } else if (transfer.recoveryId && !transfers.some(entry => entry.recoveryId === transfer.recoveryId)) {
          records = records.filter(entry => entry.id !== transfer.recoveryId || entry.status === "failed");
        }
      });
    }

    async function retry(id) {
      if (retrying.has(id)) throw new Error("This download is already being retried.");
      retrying.add(id);
      try {
        const job = await change(() => {
          const entry = records.find(record => record.id === id);
          if (!entry) throw new Error("This recovery item no longer exists.");
          if (entry.status !== "failed" || transfers.some(item => item.recoveryId === id)) throw new Error("This download is already in progress.");
          entry.status = "retrying";
          entry.attempts++;
          entry.updatedAt = Date.now();
          return structuredClone(entry.job);
        });
        try {
          const result = await runRetry(job, { recoveryId: id });
          if (result?.ok === false) throw new Error(result.error || "Retry failed.");
          await change(() => {
            const entry = records.find(record => record.id === id);
            if (entry?.status === "retrying") failed(entry.job, "The retry did not start a browser download.", id);
          });
          return result;
        } catch (error) {
          await change(() => {
            const entry = records.find(record => record.id === id);
            // A lost tab response can follow a successful download start.
            // Keep tracking it so completion cannot become a duplicate retry.
            if (entry && !transfers.some(item => item.recoveryId === id)) failed(entry.job, error, id);
          });
          throw error;
        }
      } finally { retrying.delete(id); }
    }

    async function dismiss(id) {
      return change(() => {
        if (retrying.has(id) || transfers.some(entry => entry.recoveryId === id)) throw new Error("Wait for the active download before dismissing it.");
        records = records.filter(entry => entry.id !== id);
      });
    }

    return {
      recordFailure, recordStarted, changed, retry, dismiss,
      list: () => change(() => structuredClone(records).reverse(), false),
      pending: () => change(() => transfers.map(entry => entry.id), false),
    };
  }

  root.RedditGrabRecovery = { create };
})(globalThis);
