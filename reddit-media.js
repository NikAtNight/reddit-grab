(function (root, factory) {
  const helpers = factory();
  if (typeof module === "object" && module.exports) module.exports = helpers;
  else root.RedditGrabMedia = helpers;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const MIME_EXT = Object.freeze({
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  });

  function decodeEntities(value) {
    return String(value || "")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">");
  }

  function normalizeUrl(value) {
    return decodeEntities(value).trim();
  }

  function redditJsonUrl(permalink, origin) {
    const postUrl = new URL(permalink, origin);
    const jsonUrl = new URL(postUrl.pathname, origin);
    jsonUrl.pathname = jsonUrl.pathname.replace(/\/+$/, "") + ".json";
    jsonUrl.search = "?raw_json=1";
    return jsonUrl.href;
  }

  function giphyId(value) {
    try {
      const url = new URL(normalizeUrl(value));
      if (!/(^|\.)giphy\.com$/i.test(url.hostname)) return null;
      const parts = url.pathname.split("/").filter(Boolean);
      const mediaIndex = parts.findIndex((part) => part.toLowerCase() === "media");
      if (mediaIndex >= 0 && /^[a-z0-9]+$/i.test(parts[mediaIndex + 1] || "")) {
        return parts[mediaIndex + 1];
      }
      const embedIndex = parts.findIndex((part) => part.toLowerCase() === "embed");
      if (embedIndex >= 0 && /^[a-z0-9]+$/i.test(parts[embedIndex + 1] || "")) {
        return parts[embedIndex + 1];
      }
      const gifsIndex = parts.findIndex((part) => part.toLowerCase() === "gifs");
      if (gifsIndex < 0 || !parts[gifsIndex + 1]) return null;
      const finalPart = parts[gifsIndex + 1].split("-").pop();
      return /^[a-z0-9]+$/i.test(finalPart) ? finalPart : null;
    } catch {
      return null;
    }
  }

  function directExtension(value) {
    try {
      const pathname = new URL(normalizeUrl(value)).pathname;
      return pathname.match(/\.((?:jpe?g|png|gif|webp|avif|mp4|webm))$/i)?.[1].toLowerCase() || null;
    } catch {
      return null;
    }
  }

  function direct(url, suffix, extHint) {
    return { kind: "direct", url: normalizeUrl(url), suffix, extHint: extHint || directExtension(url) || undefined };
  }

  function galleryItems(post) {
    if (!post.is_gallery || !post.media_metadata) return [];
    const metadata = post.media_metadata;
    const order = post.gallery_data?.items?.map((item) => item.media_id) || Object.keys(metadata);
    const items = [];

    for (const id of order) {
      const meta = metadata[id];
      if (!meta || meta.status !== "valid") continue;
      const suffix = `_${String(items.length + 1).padStart(2, "0")}`;
      if (meta.e === "AnimatedImage") {
        if (meta.s?.mp4) items.push(direct(meta.s.mp4, suffix, "mp4"));
        else if (meta.s?.gif) items.push(direct(meta.s.gif, suffix, "gif"));
        continue;
      }

      const ext = MIME_EXT[String(meta.m || "").toLowerCase()];
      if (meta.s?.u) items.push(direct(meta.s.u, suffix, ext));
      else if (ext) items.push(direct(`https://i.redd.it/${id}.${ext}`, suffix, ext));
    }
    return items;
  }

  function ownItems(post) {
    const gallery = galleryItems(post);
    if (gallery.length) return gallery;

    const describeRedditVideo = (redditVideo) => {
      const audio =
        redditVideo.has_audio === true
          ? "required"
          : redditVideo.has_audio === false
            ? "none"
            : "probe";
      return [{
        kind: "reddit-video",
        videoUrl: normalizeUrl(redditVideo.fallback_url) || null,
        dashUrl: normalizeUrl(redditVideo.dash_url) || null,
        audio,
        suffix: "",
      }];
    };

    const nativeRedditVideo = post.secure_media?.reddit_video || post.media?.reddit_video;
    if (nativeRedditVideo?.fallback_url || nativeRedditVideo?.dash_url) {
      return describeRedditVideo(nativeRedditVideo);
    }

    const sourceUrl = normalizeUrl(post.url_overridden_by_dest || post.url);
    const supplied = globalThis.RedditGrabProviders?.extract(sourceUrl);
    if (supplied?.length) return supplied;

    // Already-direct Giphy URLs should remain direct. Page and embed links are
    // represented as external items so the background can choose GIF or MP4.
    if (/\.gifv(?:[?#]|$)/i.test(sourceUrl)) {
      return [direct(sourceUrl.replace(/\.gifv(?=[?#]|$)/i, ".mp4"), "", "mp4")];
    }

    const ext = directExtension(sourceUrl);
    if (ext) {
      return [direct(sourceUrl, "", ext)];
    }

    const gyId = giphyId(sourceUrl);
    if (gyId) return [{ kind: "external", provider: "giphy", id: gyId, sourceUrl, suffix: "" }];

    const previewVideo = post.preview?.reddit_video_preview;
    if (previewVideo?.fallback_url || previewVideo?.dash_url) {
      return describeRedditVideo(previewVideo);
    }

    const previewUrl = post.preview?.images?.[0]?.source?.url;
    return previewUrl ? [direct(previewUrl, "")] : [];
  }

  function findSource(post, seen, depth) {
    if (!post || typeof post !== "object" || depth > 8 || seen.has(post)) return null;
    seen.add(post);

    const crosspost = Array.isArray(post.crosspost_parent_list) ? post.crosspost_parent_list[0] : null;
    if (crosspost) {
      const inner = findSource(crosspost, seen, depth + 1);
      if (inner?.items.length) return inner;
    }

    const items = ownItems(post);
    return items.length ? { post, items } : null;
  }

  function extractMedia(post) {
    const source = findSource(post, new WeakSet(), 0);
    return {
      postId: post?.id || "post",
      subreddit: post?.subreddit || "reddit",
      sourcePostId: source?.post?.id || post?.id || "post",
      sourceSubreddit: source?.post?.subreddit || post?.subreddit || "reddit",
      items: source?.items || [],
    };
  }

  function attributes(value) {
    const result = {};
    for (const match of String(value).matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/g)) {
      result[match[1].toLowerCase()] = decodeEntities(match[3]);
    }
    return result;
  }

  function firstBaseUrl(xml) {
    return xml.match(/<BaseURL(?:\s[^>]*)?>([\s\S]*?)<\/BaseURL>/i)?.[1]?.trim() || null;
  }

  function resolveUrl(value, base) {
    try {
      if (!value) return null;
      const raw = decodeEntities(value).trim();
      const resolved = new URL(raw, base);
      const baseUrl = new URL(base);
      if (!resolved.search && !raw.includes("?") && baseUrl.search) {
        resolved.search = baseUrl.search;
      }
      return resolved.href;
    } catch {
      return null;
    }
  }

  function candidateKind(adaptation, representation, baseUrl) {
    const hint = [
      adaptation.contenttype,
      adaptation.mimetype,
      adaptation.codecs,
      representation.contenttype,
      representation.mimetype,
      representation.codecs,
      representation.id,
      baseUrl,
    ].join(" ");
    if (/audio/i.test(hint) || /mp4a|opus|vorbis/i.test(hint)) return "audio";
    if (/video/i.test(hint) || /avc|h26[45]|vp0?9|av01/i.test(hint)) return "video";
    return null;
  }

  function parseDashManifest(xml, manifestUrl) {
    const candidates = [];
    const documentBody = String(xml);
    const withoutAdaptations = documentBody.replace(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/gi, "");
    const documentBase = resolveUrl(firstBaseUrl(withoutAdaptations), manifestUrl) || manifestUrl;
    const adaptationPattern = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
    for (const adaptationMatch of documentBody.matchAll(adaptationPattern)) {
      const adaptation = attributes(adaptationMatch[1]);
      const body = adaptationMatch[2];
      const withoutRepresentations = body.replace(/<Representation\b[\s\S]*?<\/Representation>/gi, "");
      const adaptationBase = resolveUrl(firstBaseUrl(withoutRepresentations), documentBase) || documentBase;
      const representationPattern = /<Representation\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/Representation>)/gi;

      for (const representationMatch of body.matchAll(representationPattern)) {
        const representation = attributes(representationMatch[1]);
        const baseValue = firstBaseUrl(representationMatch[2] || "");
        const url = resolveUrl(baseValue, adaptationBase);
        const kind = candidateKind(adaptation, representation, baseValue);
        if (!url || !kind) continue;
        candidates.push({
          kind,
          url,
          bandwidth: Number.parseInt(representation.bandwidth, 10) || 0,
        });
      }
    }

    const best = (kind) => candidates
      .filter((candidate) => candidate.kind === kind)
      .sort((a, b) => b.bandwidth - a.bandwidth)[0]?.url || null;
    return { videoUrl: best("video"), audioUrl: best("audio") };
  }

  return {
    MIME_EXT,
    extractMedia,
    giphyId,
    normalizeUrl,
    parseDashManifest,
    redditJsonUrl,
  };
});
