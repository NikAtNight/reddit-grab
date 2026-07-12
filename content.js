// Reddit Image Grab — content script.
// Shows a "Save images" button when hovering an image/gallery post.
// Clicking it fetches the post's JSON (which lists every gallery image at
// full resolution) and hands the URLs to the background worker to download.

(() => {
  "use strict";

  // Firefox: promise-based `browser` namespace; Chrome: MV3 `chrome` is
  // promise-based too, so they are interchangeable here.
  const api = typeof browser !== "undefined" ? browser : chrome;

  let button = null;
  let currentPost = null; // { el, permalink }
  let busy = false;

  // ---------------------------------------------------------------- overlay

  function ensureButton() {
    if (button) return button;
    button = document.createElement("button");
    button.id = "reddit-grab-btn";
    button.type = "button";
    Object.assign(button.style, {
      position: "absolute",
      zIndex: "2147483647",
      display: "none",
      alignItems: "center",
      gap: "6px",
      padding: "6px 12px",
      border: "none",
      borderRadius: "999px",
      background: "#d93a00",
      color: "#fff",
      font: "600 13px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      cursor: "pointer",
      boxShadow: "0 2px 8px rgba(0,0,0,.35)",
    });
    button.textContent = "⬇︎ Save media";
    button.addEventListener("click", onButtonClick);
    button.addEventListener("mouseenter", () => {
      /* keep visible while hovered */
    });
    document.body.appendChild(button);
    return button;
  }

  // Pin to the bottom-right corner of the post.
  function positionButton(postEl) {
    const rect = postEl.getBoundingClientRect();
    const bw = button.offsetWidth || 120;
    const bh = button.offsetHeight || 30;
    button.style.left = `${window.scrollX + rect.right - bw - 8}px`;
    button.style.top = `${window.scrollY + rect.bottom - bh - 8}px`;
  }

  function showButtonFor(postEl, permalink) {
    const btn = ensureButton();
    currentPost = { el: postEl, permalink };
    if (!busy) btn.textContent = "⬇︎ Save media";
    btn.style.display = "inline-flex"; // must be visible before measuring
    positionButton(postEl);
  }

  function hideButton() {
    if (button && !busy) {
      button.style.display = "none";
      currentPost = null;
    }
  }

  // ------------------------------------------------------------- post lookup

  // Walk the composed event path (pierces shadow DOM) looking for a post
  // container we know how to handle. Returns { el, permalink } or null.
  function findPost(path) {
    for (const node of path) {
      if (!(node instanceof Element)) continue;

      // New Reddit (shreddit web components)
      if (node.tagName === "SHREDDIT-POST") {
        const type = node.getAttribute("post-type");
        const href = node.getAttribute("content-href") || "";
        const isMediaType = ["gallery", "image", "gif", "video"].includes(type);
        // Link/embed posts pointing at a gif host we can resolve
        const isMediaHost = /giphy\.com\/(gifs|embed)|\.(gifv?|mp4|jpe?g|png|webp)(\?|$)/i.test(href);
        if (!isMediaType && !isMediaHost) return null;
        const permalink = node.getAttribute("permalink");
        return permalink ? { el: node, permalink } : null;
      }

      // Old Reddit
      if (node.classList && node.classList.contains("thing") && node.dataset.permalink) {
        const domain = node.dataset.domain || "";
        const url = node.dataset.url || "";
        const isMedia =
          domain === "i.redd.it" ||
          domain === "preview.redd.it" ||
          domain === "v.redd.it" ||
          domain === "i.imgur.com" ||
          domain.endsWith("giphy.com") ||
          url.includes("/gallery/") ||
          /\.(jpe?g|png|gif|gifv|webp|mp4)(\?|$)/i.test(url);
        return isMedia ? { el: node, permalink: node.dataset.permalink } : null;
      }
    }
    return null;
  }

  document.addEventListener(
    "mouseover",
    (e) => {
      if (button && e.composedPath().includes(button)) return; // hovering our button
      const post = findPost(e.composedPath());
      if (post) {
        showButtonFor(post.el, post.permalink);
      } else {
        hideButton();
      }
    },
    true
  );

  window.addEventListener(
    "scroll",
    () => {
      // Reposition rather than leaving the button floating over the wrong post.
      if (currentPost && button && button.style.display !== "none" && !busy) {
        positionButton(currentPost.el);
      }
    },
    { passive: true }
  );

  // -------------------------------------------------------------- media URLs

  const MIME_EXT = {
    "image/jpg": "jpg",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
  };

  function mediaDirectoryUrl(url) {
    // Reddit now uses both v.redd.it/<id>/... and nested
    // v.redd.it/link/<post>/asset/<id>/... paths. URL resolution must keep the
    // entire directory; taking only the first path segment loses the asset ID.
    return new URL(".", url).href;
  }

  function audioQuality(url) {
    // Prefer the bitrate encoded in Reddit's audio filenames. Some current
    // manifests report the same (incorrectly low) bandwidth for both the 64
    // and 128 variants, so the Representation bandwidth is not dependable.
    const match = url.match(/audio[^0-9]*(\d+)/i) || url.match(/(\d+)(?=\.[a-z0-9]+(?:\?|$))/i);
    return match ? parseInt(match[1], 10) : 0;
  }

  // v.redd.it serves video and audio as separate DASH streams. Read the DASH
  // manifest (the player fetches it cross-origin too, so CORS allows it) and
  // pick the highest-bitrate audio track. Returns a URL or null (no audio).
  async function findAudioUrl(videoUrl, dashUrl) {
    let videoBase;
    try {
      const parsed = new URL(videoUrl);
      if (parsed.hostname !== "v.redd.it") return null;
      videoBase = mediaDirectoryUrl(parsed.href);
    } catch {
      return null;
    }

    const manifestUrl = dashUrl || new URL("DASHPlaylist.mpd", videoBase).href;
    let mediaBase = videoBase;
    try {
      mediaBase = mediaDirectoryUrl(manifestUrl);
      const res = await fetch(manifestUrl);
      if (res.ok) {
        const xml = await res.text();
        const audio = [...xml.matchAll(/<BaseURL>([^<]+)<\/BaseURL>/g)]
          .map((mm) => mm[1])
          .filter((u) => /audio/i.test(u))
          .sort((a, b) => audioQuality(b) - audioQuality(a));
        // BaseURL entries are relative to the manifest, not the v.redd.it
        // origin or its first path segment.
        if (audio.length) return new URL(audio[0], manifestUrl).href;
      }
    } catch {
      /* manifest blocked/unreachable — fall through to known URL patterns */
    }

    // Cover both Reddit's older DASH names and its current CMAF names if the
    // manifest cannot be read.
    for (const name of [
      "CMAF_AUDIO_128.mp4",
      "CMAF_AUDIO_64.mp4",
      "DASH_AUDIO_128.mp4",
      "DASH_audio.mp4",
    ]) {
      const candidate = new URL(name, mediaBase).href;
      try {
        const res = await fetch(candidate, { method: "HEAD" });
        if (res.ok) return candidate;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  // Returns { files: [{ url, suffix }], subreddit, postId }.
  async function extractMedia(post) {
    // Crossposts carry the media on the original post.
    if (Array.isArray(post.crosspost_parent_list) && post.crosspost_parent_list.length) {
      const inner = await extractMedia(post.crosspost_parent_list[0]);
      if (inner.files.length) return inner;
    }

    const files = [];
    const rv =
      post.secure_media?.reddit_video ||
      post.media?.reddit_video ||
      post.preview?.reddit_video_preview;

    if (post.is_gallery && post.media_metadata) {
      const order = post.gallery_data?.items?.map((it) => it.media_id) || Object.keys(post.media_metadata);
      let n = 0;
      for (const id of order) {
        const meta = post.media_metadata[id];
        if (!meta || meta.status !== "valid") continue;
        const suffix = `_${String(++n).padStart(2, "0")}`;
        if (meta.e === "AnimatedImage" && (meta.s?.gif || meta.s?.mp4)) {
          files.push({ url: meta.s.gif || meta.s.mp4, suffix });
        } else if (MIME_EXT[meta.m]) {
          // i.redd.it/<id>.<ext> is the full-resolution original.
          files.push({ url: `https://i.redd.it/${id}.${MIME_EXT[meta.m]}`, suffix });
        } else if (meta.s?.u) {
          files.push({ url: meta.s.u, suffix });
        }
      }
    } else if (rv?.fallback_url) {
      // v.redd.it video or "gif" — fallback_url is the highest-quality video
      // stream (video only; audio, when present, is a separate stream).
      const videoUrl = rv.fallback_url;
      const mayHaveAudio = rv.has_audio === true || (rv.has_audio !== false && !rv.is_gif);
      const audio = mayHaveAudio ? await findAudioUrl(videoUrl, rv.dash_url) : null;
      if (audio) {
        // Merged into a single MP4 with sound by the background muxer.
        files.push({ mux: { video: videoUrl, audio }, suffix: "" });
      } else {
        files.push({ url: videoUrl, suffix: "" });
      }
    } else {
      const url = post.url_overridden_by_dest || post.url || "";
      const giphyId = url.match(/giphy\.com\/(?:gifs|embed)\/(?:[\w-]*-)?([a-zA-Z0-9]+)(?:[/?#]|$)/)?.[1];
      if (giphyId) {
        // i.giphy.com serves the original gif directly by ID.
        files.push({ url: `https://i.giphy.com/${giphyId}.gif`, suffix: "" });
      } else if (/\.gifv(\?|$)/i.test(url)) {
        // imgur .gifv is just an mp4 behind a player page
        files.push({ url: url.replace(/\.gifv(\?.*)?$/i, ".mp4"), suffix: "" });
      } else if (/^https?:\/\/i\.redd\.it\//.test(url) || /\.(jpe?g|png|gif|webp|mp4)(\?|$)/i.test(url)) {
        files.push({ url, suffix: "" });
      } else if (post.preview?.images?.[0]?.source?.url) {
        files.push({ url: post.preview.images[0].source.url, suffix: "" });
      }
    }

    return {
      files,
      subreddit: post.subreddit || "reddit",
      postId: post.id || "post",
    };
  }

  function setStatus(text) {
    if (button && busy) button.textContent = text;
  }

  // Reddit rate-limits the JSON endpoint per minute. On 429, wait what
  // Retry-After asks for (falling back to exponential backoff) and retry.
  async function fetchWithRetry(url, attempts = 3) {
    for (let i = 0; ; i++) {
      const res = await fetch(url, { credentials: "same-origin" });
      if (res.status !== 429) return res;
      if (i >= attempts - 1) {
        throw new Error("Rate limited — wait a minute and retry");
      }
      const wait = Math.min(parseInt(res.headers.get("retry-after"), 10) || 5 * 2 ** i, 60);
      for (let left = wait; left > 0; left--) {
        setStatus(`⏳ Rate limited — retrying in ${left}s`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      setStatus("⏳ Fetching…");
    }
  }

  async function downloadPost(permalink) {
    const url = new URL(permalink, location.origin);
    url.hostname = "www.reddit.com"; // old./new. subdomains serve the same JSON
    url.pathname = url.pathname.replace(/\/$/, "") + ".json";
    url.search = "?raw_json=1";

    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`Reddit returned ${res.status}`);
    const data = await res.json();
    const post = data?.[0]?.data?.children?.[0]?.data;
    if (!post) throw new Error("Unexpected JSON shape");

    const extracted = await extractMedia(post);
    if (!extracted.files.length) throw new Error("No media found");

    const reply = await api.runtime.sendMessage({ type: "download-images", ...extracted });
    if (!reply?.ok) throw new Error(reply?.error || "Download failed");
    return reply.count;
  }

  async function onButtonClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (busy || !currentPost) return;
    busy = true;
    button.textContent = "⏳ Fetching…";
    try {
      const count = await downloadPost(currentPost.permalink);
      button.textContent = `✓ ${count} saved`;
      button.style.background = "#0e8a16";
    } catch (err) {
      console.error("[Reddit Image Grab]", err);
      button.textContent = `✕ ${err.message}`;
      button.style.background = "#666";
    }
    setTimeout(() => {
      busy = false;
      if (button) {
        button.style.background = "#d93a00";
        hideButton();
      }
    }, 1800);
  }

  // Toolbar icon clicked while viewing a post page: download that post.
  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "download-current") return;
    const m = location.pathname.match(/\/(?:r|user|u)\/[^/]+\/comments\/[a-z0-9]+/i);
    if (!m) {
      sendResponse({ ok: false, error: "Open a post first" });
      return;
    }
    downloadPost(m[0])
      .then((count) => sendResponse({ ok: true, count }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  });
})();
