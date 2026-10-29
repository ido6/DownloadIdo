// Isolated-world content script (every frame). Remembers where the user right-clicked and
// finds the image/video under that point, even beneath overlays or as a CSS background.
// The service worker calls the functions on globalThis.DownloadIdoContent via scripting.executeScript.
(function () {
  'use strict';
  // After an extension update/reload the old copy can linger here with a dead runtime
  // ("context invalidated"); replace it rather than leave stale code answering.
  const existing = globalThis.DownloadIdoContent;
  if (existing && typeof existing.isAlive === 'function' && existing.isAlive()) return; // older builds lack isAlive

  function isAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  const U = globalThis.DownloadIdoUtils;
  const MSG_SOURCE = 'downloadido';
  const MARKER_ATTR = 'data-downloadido-target';
  const MIN_BULK_SIZE = 64; // px; skips icons, spacers and tracking pixels
  const MIN_BG_SIZE = 48; // px; a background smaller than this under the cursor is a UI icon
  const MAX_BULK_ELEMENTS = 8000; // cap computed-style scans on huge pages
  const MAX_BULK_ITEMS = 1000;
  const REVOKE_AFTER_MS = 10 * 60 * 1000;
  const MSE_TIMEOUT_MS = 10 * 1000;
  const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-full-src', 'data-hi-res-src'];
  const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'];

  let lastPoint = null;

  document.addEventListener('contextmenu', (e) => {
    if (e.isTrusted) lastPoint = { x: e.clientX, y: e.clientY }; // pages can't fake the target
  }, true);

  // ------------------------------------------------------------ hit testing

  function deepElementsFromPoint(root, x, y, seen = new Set()) {
    const out = [];
    for (const el of root.elementsFromPoint(x, y)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.shadowRoot) out.push(...deepElementsFromPoint(el.shadowRoot, x, y, seen));
      out.push(el);
    }
    return out;
  }

  function deepQueryAll(root, selector, out = []) {
    out.push(...root.querySelectorAll(selector));
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) deepQueryAll(el.shadowRoot, selector, out);
    }
    return out;
  }

  function containsPoint(el, x, y) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function area(el) {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  }

  function atLeast(el, min) {
    const r = el.getBoundingClientRect();
    return r.width >= min && r.height >= min;
  }

  // ------------------------------------------------------------ resolvers

  function abs(url) {
    return url ? U.resolveUrl(url, document.baseURI) : '';
  }

  function isPlaceholder(url) {
    return !url || (url.startsWith('data:') && url.length < 2000);
  }

  /** Largest available URL for an <img>: srcset / <picture> / lazy attrs / linked full-size image. */
  function bestImageUrl(img) {
    const candidates = [];
    const addSrcset = (value) => {
      for (const c of U.parseSrcset(value)) candidates.push({ ...c, url: abs(c.url) });
    };
    addSrcset(img.getAttribute('srcset'));
    if (img.parentElement && img.parentElement.tagName === 'PICTURE') {
      for (const source of img.parentElement.querySelectorAll('source')) addSrcset(source.getAttribute('srcset'));
    }
    let url = U.pickLargestCandidate(candidates) || img.currentSrc || img.src;

    if (isPlaceholder(url)) {
      for (const attr of LAZY_SRCSET_ATTRS) addSrcset(img.getAttribute(attr));
      const lazy = U.pickLargestCandidate(candidates.filter((c) => !isPlaceholder(c.url)))
        || LAZY_ATTRS.map((a) => abs(img.getAttribute(a))).find((v) => v);
      if (lazy) url = lazy;
    }

    const link = img.closest('a[href]');
    if (link && U.isImageExt(U.extFromUrl(link.href))) url = link.href;
    return url;
  }

  function backgroundUrl(el) {
    for (const pseudo of [null, '::before', '::after']) {
      const urls = U.extractCssUrls(getComputedStyle(el, pseudo).backgroundImage);
      if (urls.length) return abs(urls[0]);
    }
    return '';
  }

  function videoSource(video) {
    const source = video.querySelector('source[src]');
    return video.currentSrc || video.src || (source ? abs(source.getAttribute('src')) : '');
  }

  function findMarkedVideo(marker) {
    return deepQueryAll(document, `[${MARKER_ATTR}="${CSS.escape(marker)}"]`)[0] || null;
  }

  function clearMarker(marker) {
    const video = findMarkedVideo(marker);
    if (video) video.removeAttribute(MARKER_ATTR);
  }

  /** Describe a <video>. Only `mark` (single-target downloads) tags the element for later export. */
  function describeVideo(video, mark) {
    if (video.mediaKeys) return { kind: 'drm' };
    const src = videoSource(video);
    const title = document.title;
    if (!src && !video.srcObject) return { kind: 'none', reason: 'This video has no source yet. Play it, then try again.' };
    if (src && U.isHlsUrl(src)) return { kind: 'hls', url: src, title, duration: video.duration };
    if (src && /^(https?|data):/i.test(src)) return { kind: 'url', url: src, media: video.tagName === 'AUDIO' ? 'audio' : 'video', title };
    if (!mark) return { kind: 'stream' };
    const marker = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    video.setAttribute(MARKER_ATTR, marker);
    return { kind: 'stream', marker, title, duration: video.duration };
  }

  function describeImage(url) {
    if (!url) return null;
    if (url.startsWith('blob:')) return { kind: 'blob', url, media: 'image' };
    return { kind: 'url', url, media: 'image' };
  }

  /**
   * What the user right-clicked on: {kind:'url'|'blob'|'hls'|'stream'|'drm'|'none', pageUrl, ...}.
   * pageUrl is this frame's address: embedded players' servers expect it as the Referer.
   */
  function resolveTarget() {
    return { ...findTarget(), pageUrl: location.href };
  }

  function findTarget() {
    if (!lastPoint) return { kind: 'none', reason: 'Right-click directly on the image or video.' };
    const { x, y } = lastPoint;
    const stack = deepElementsFromPoint(document, x, y);

    // Real media anywhere under the cursor beats CSS backgrounds (play-button sprites, overlays).
    for (const el of stack) {
      if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') return describeVideo(el, true);
      if (el.tagName === 'IMG') {
        const target = describeImage(bestImageUrl(el));
        if (target) return target;
      }
    }
    for (const el of stack) {
      if (!atLeast(el, MIN_BG_SIZE)) continue;
      const target = describeImage(backgroundUrl(el));
      if (target) return target;
    }

    // pointer-events:none media are invisible to hit testing: fall back to geometry.
    const covering = deepQueryAll(document, 'img, video, audio')
      .filter((el) => containsPoint(el, x, y))
      .sort((a, b) => area(a) - area(b));
    for (const el of covering) {
      if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') return describeVideo(el, true);
      const target = describeImage(bestImageUrl(el));
      if (target) return target;
    }
    return { kind: 'none', reason: 'No image or video found under the cursor.' };
  }

  // ------------------------------------------------------------ bulk

  /** Every downloadable image/video URL in this frame. Streams are only counted. */
  function collectAll() {
    const items = new Map();
    let skippedStreams = 0;
    const add = (url, media) => {
      if (items.size >= MAX_BULK_ITEMS || !url || isPlaceholder(url) || !/^(https?|data):/i.test(url)) return;
      if (!items.has(url)) items.set(url, { url, media });
    };

    for (const img of deepQueryAll(document, 'img')) {
      // naturalWidth is density-corrected by srcset/sizes, so also consider the rendered size.
      const r = img.getBoundingClientRect();
      const tiny = img.complete && img.naturalWidth > 0
        && Math.max(img.naturalWidth, r.width) < MIN_BULK_SIZE && Math.max(img.naturalHeight, r.height) < MIN_BULK_SIZE;
      if (!tiny) add(bestImageUrl(img), 'image');
    }
    for (const video of deepQueryAll(document, 'video')) {
      const d = describeVideo(video, false);
      if (d.kind === 'url') add(d.url, 'video');
      else if (d.kind === 'stream' || d.kind === 'hls' || d.kind === 'drm') skippedStreams++;
    }
    const all = deepQueryAll(document, '*');
    for (const el of all.slice(0, MAX_BULK_ELEMENTS)) {
      if (el.tagName === 'IMG' || el.tagName === 'VIDEO' || !atLeast(el, MIN_BULK_SIZE)) continue;
      add(backgroundUrl(el), 'image');
    }
    return { items: [...items.values()], skippedStreams, title: document.title, host: location.hostname, pageUrl: location.href };
  }

  // ------------------------------------------------------------ stream export

  function toBlobUrl(blob) {
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
    return url;
  }

  function askMainWorld(marker) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => done({ error: 'The page did not answer. Reload it, play the video, then try again.' }), MSE_TIMEOUT_MS);
      function done(result) {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(result);
      }
      function onMessage(event) {
        const m = event.data;
        if (event.source === window && m && m.source === MSG_SOURCE && m.type === 'mse-export-result' && m.id === id) done(m);
      }
      window.addEventListener('message', onMessage);
      window.postMessage({ source: MSG_SOURCE, type: 'mse-export', id, marker }, '*');
    });
  }

  /** The reply crosses from the page's world, so check its shape before trusting it. */
  function validTracks(result) {
    return Array.isArray(result.tracks) && result.tracks.length > 0
      && result.tracks.every((t) => t && t.blob instanceof Blob && typeof t.mime === 'string');
  }

  /**
   * Read a blob:-sourced video/audio element's bytes.
   * mode 'blob': only works when the src is a plain Blob (full file) -> {tracks:[{blob, mime}]}.
   * mode 'mse':  what the MediaSource player has buffered, one Blob per track.
   * Errors come back as {error}; 'not-a-blob' means "try the next way".
   */
  async function readStream(marker, mode) {
    const video = findMarkedVideo(marker);
    if (!video) return { error: 'Video element is gone. Try again.' };
    if (mode === 'blob') {
      const src = videoSource(video);
      if (!src.startsWith('blob:')) return { error: 'not-a-blob' };
      try {
        const blob = await (await fetch(src)).blob();
        if (!blob.size) return { error: 'empty' };
        clearMarker(marker);
        return { truncated: false, tracks: [{ blob, mime: blob.type || 'video/mp4' }] };
      } catch {
        return { error: 'not-a-blob' }; // MediaSource URLs cannot be fetched
      }
    }
    try {
      const result = await askMainWorld(marker);
      if (result.error) return { error: String(result.error) };
      if (!validTracks(result)) return { error: 'The page returned unusable stream data.' };
      return { truncated: result.tracks.some((t) => t.truncated), tracks: result.tracks.map((t) => ({ blob: t.blob, mime: t.mime })) };
    } finally {
      clearMarker(marker);
    }
  }

  /** Turn a blob:-sourced video into downloadable blob URLs (see readStream for modes). */
  async function exportStream(marker, mode) {
    const result = await readStream(marker, mode);
    if (result.error) return result;
    if (mode === 'blob') return { files: [{ url: toBlobUrl(result.tracks[0].blob), mime: result.tracks[0].mime, part: '' }] };
    const { truncated } = result;
    const muxed = await muxAudioVideo(result.tracks);
    if (muxed) return { truncated, files: [{ url: toBlobUrl(muxed), mime: 'video/mp4', part: '' }] };
    const multi = result.tracks.length > 1;
    return {
      truncated,
      files: result.tracks.map((t) => ({
        url: toBlobUrl(t.blob),
        mime: t.blob.type,
        part: multi ? (t.mime.startsWith('audio') ? 'audio' : 'video') : '',
      })),
    };
  }

  /**
   * Start converting a blob:-sourced element's audio to MP3 (needs lib/mp3.js, injected on
   * demand). Returns at once: {started: true} or {error}. The result arrives later as a
   * runtime message {type: 'mp3-done', jobId, url | error}, with 'mp3-progress' on the way,
   * because a long encode would outlive a single scripting call.
   */
  async function startStreamMp3(marker, mode, jobId, kbps) {
    const result = await readStream(marker, mode);
    if (result.error) return result;
    const audio = result.tracks.find((t) => t.mime.startsWith('audio'))
      || (result.tracks.length === 1 ? result.tracks[0] : null);
    if (!audio) return { error: 'This video has no separate audio track to convert.' };
    convertToMp3(audio.blob, jobId, result.truncated, kbps);
    return { started: true };
  }

  async function convertToMp3(blob, jobId, truncated, kbps) {
    const send = (msg) => chrome.runtime.sendMessage({ jobId, ...msg }).catch(() => {});
    let lastPct = -1;
    try {
      const mp3 = await globalThis.DownloadIdoMp3.toMp3(blob, {
        kbps,
        onProgress: (fraction) => {
          const pct = Math.floor(fraction * 100);
          if (pct - lastPct >= 2) send({ type: 'mp3-progress', pct: (lastPct = pct) });
        },
      });
      send({ type: 'mp3-done', url: toBlobUrl(mp3), truncated });
    } catch (e) {
      send({ type: 'mp3-done', error: String((e && e.message) || e) });
    }
  }

  /** One MP4 from a separate MP4 video track + MP4 audio track, or null (then: two files). */
  function muxAudioVideo(tracks) {
    if (tracks.length !== 2) return null;
    const video = tracks.find((t) => t.mime.startsWith('video/mp4'));
    const audio = tracks.find((t) => t.mime.startsWith('audio/mp4'));
    return video && audio ? globalThis.DownloadIdoFmp4.mux(video.blob, audio.blob) : null;
  }

  /** Copy a page-owned blob: URL (e.g. a generated image) into one the extension can download. */
  async function fetchBlobUrl(url) {
    if (!String(url).startsWith('blob:')) return { error: 'not a blob URL' };
    try {
      const blob = await (await fetch(url)).blob();
      return { url: toBlobUrl(blob), mime: blob.type };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  /**
   * Read a page-owned blob: image's bytes as a data URL. The viewer tab can't use the page's
   * blob URL (wrong origin), so the bytes cross over as text; big images are refused up front.
   */
  async function fetchBlobDataUrl(url, maxBytes) {
    if (!String(url).startsWith('blob:')) return { error: 'not a blob URL' };
    try {
      const blob = await (await fetch(url)).blob();
      if (blob.size > maxBytes) {
        return { error: 'This image is too large to view directly. Use "Download image / video" instead.' };
      }
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(/** @type {string} */ (reader.result));
        reader.onerror = () => reject(new Error('The image could not be read.'));
        reader.readAsDataURL(blob);
      });
      return { url: dataUrl };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  globalThis.DownloadIdoContent = { isAlive, resolveTarget, collectAll, exportStream, startStreamMp3, fetchBlobUrl, fetchBlobDataUrl, clearMarker };
})();
