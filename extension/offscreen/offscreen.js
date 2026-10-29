// Offscreen document: does the long-running HLS work the service worker can't
// (it has no URL.createObjectURL and may be suspended). Picks the playlist that matches the
// video, fetches the best variant, decrypts AES-128 segments, joins them, and hands blob URLs
// back for chrome.downloads.
export {}; // ES module: keeps this file's names out of the shared global scope

const U = globalThis.DownloadIdoUtils;
const CONCURRENCY = 6;
const RETRIES = 2;
const MAX_SEGMENTS = 50000;
const REVOKE_AFTER_MS = 10 * 60 * 1000;
const PROGRESS_STEP = 2; // percent
const EXT_MIME = { mp4: 'video/mp4', m4a: 'audio/mp4', ts: 'video/mp2t', aac: 'audio/aac', mp3: 'audio/mpeg' };

const JOBS = { hls: runHlsJob, fetch: runFetchJob, viewfetch: runFetchJob, mp3: runMp3Job, hlsmp3: (job) => runHlsJob({ ...job, audioOnly: true }) };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const run = msg?.target === 'offscreen' && sender.id === chrome.runtime.id && JOBS[msg.type];
  if (!run) return false;
  sendResponse({ accepted: true });
  const doneType = `${msg.type}-done`;
  run(msg).then(
    (result) => chrome.runtime.sendMessage({ type: doneType, job: msg, ...result }),
    (e) => chrome.runtime.sendMessage({ type: doneType, job: msg, error: String((e && e.message) || e) }),
  );
  return false;
});

function toBlobUrl(blob) {
  const url = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  return url;
}

/** Re-fetch a file the server refused to chrome.downloads (this request carries the page's Referer). */
async function runFetchJob(job) {
  return { url: toBlobUrl(await fetchBlob(job, job.url)) };
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'unknown host'; }
}

/** Fetch one resource as a Blob (Chrome can keep big Blobs on disk instead of in memory). */
async function fetchBlob(job, url, byterange) {
  if (!U.isAllowedFetch(url, job.pageUrl)) throw new Error(`Blocked a request to ${hostOf(url)} (local network).`);
  const end = byterange ? byterange.offset + byterange.length : 0;
  const headers = byterange ? { Range: `bytes=${byterange.offset}-${end - 1}` } : undefined;
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (job.aborted) throw lastError || new Error('Stopped.');
    try {
      const res = await fetch(url, { credentials: 'include', headers });
      if (!res.ok) throw new Error(`The server at ${hostOf(url)} answered ${res.status}.`);
      const blob = await res.blob();
      // A server that ignores Range sends the whole file: cut out the part we asked for.
      return byterange && res.status !== 206 ? blob.slice(byterange.offset, end) : blob;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

async function fetchPlaylist(job, url) {
  return U.parseM3u8(await (await fetchBlob(job, url)).text(), url);
}

/** A sniffed playlist as downloadable tracks: video (+ separate audio for masters). */
async function toTracks(job, url) {
  const parsed = await fetchPlaylist(job, url);
  if (parsed.type === 'media') return { isMaster: false, tracks: [{ part: '', playlist: parsed }] };
  const { variant, audio } = U.pickBestVariant(parsed);
  if (!variant) return null;
  const tracks = [{ part: audio ? 'video' : '', playlist: await fetchPlaylist(job, variant.url) }];
  if (audio) tracks.push({ part: 'audio', playlist: await fetchPlaylist(job, audio.url) });
  return { isMaster: true, tracks };
}

/**
 * Newest sniffed playlist first; a master beats a media playlist (which is often just one of
 * its variants); and the length must match the right-clicked video, so an earlier ad or
 * preview stream on the same tab isn't saved by mistake.
 */
async function choosePlaylists(job) {
  let media = null;
  for (const url of job.playlists) {
    let candidate;
    try {
      candidate = await toTracks(job, url);
    } catch {
      continue;
    }
    if (!candidate || !U.durationMatches(U.playlistDuration(candidate.tracks[0].playlist), job.duration)) continue;
    if (candidate.isMaster) return candidate.tracks;
    media = media || candidate.tracks;
  }
  if (!media) throw new Error('No stream playlist matches this video.');
  return media;
}

function makeKeyLoader(job) {
  const cache = new Map();
  return (url) => {
    if (!cache.has(url)) {
      cache.set(url, fetchBlob(job, url)
        .then((b) => b.arrayBuffer())
        .then((raw) => crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt'])));
    }
    return cache.get(url);
  };
}

async function downloadSegment(job, seg, loadKey) {
  const data = await fetchBlob(job, seg.url, seg.byterange);
  if (!seg.key) return data;
  if (seg.key.method !== 'AES-128') throw new Error(`Encrypted with ${seg.key.method} (DRM), so it can't be downloaded.`);
  const key = await loadKey(seg.key.url);
  const iv = U.buildIv(seg.key.iv, seg.sequence);
  return new Blob([await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, await data.arrayBuffer())]);
}

/** Run fn over items with limited parallelism, keeping result order; stop all on first failure. */
async function mapLimit(job, items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length && !job.aborted) {
      const i = next++;
      try {
        results[i] = await fn(items[i]);
      } catch (e) {
        job.aborted = true;
        throw e;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function trackExt(track) {
  const { playlist, part } = track;
  if (playlist.map) return part === 'audio' ? 'm4a' : 'mp4';
  const segExt = U.extFromUrl(playlist.segments[0]?.url || '');
  return segExt === 'aac' || segExt === 'mp3' ? segExt : 'ts';
}

/** Progress reporter for the toolbar badge: report(fraction) maps into [from, to] percent. */
function progressReporter(job, from = 0, to = 100) {
  let lastReported = -PROGRESS_STEP;
  return (fraction) => {
    const pct = Math.floor(from + fraction * (to - from));
    if (pct - lastReported >= PROGRESS_STEP) {
      lastReported = pct;
      chrome.runtime.sendMessage({ type: 'hls-progress', tabId: job.tabId, pct });
    }
  };
}

/** A direct media URL -> MP3 (MP3 files pass through, others are decoded and re-encoded). */
async function runMp3Job(job) {
  const mp3 = await globalThis.DownloadIdoMp3.toMp3(await fetchBlob(job, job.url), { kbps: job.kbps, onProgress: progressReporter(job) });
  return { files: [{ url: toBlobUrl(mp3), ext: 'mp3', part: '' }] };
}

async function runHlsJob(job) {
  let tracks = await choosePlaylists(job);
  if (job.audioOnly) {
    // MP3 only needs the sound: fetch just the audio rendition when the stream has one.
    tracks = [tracks.find((t) => t.part === 'audio') || tracks[0]];
    if (U.playlistDuration(tracks[0].playlist) > globalThis.DownloadIdoMp3.MAX_SECONDS) {
      throw new Error('Audio longer than 60 minutes can\'t be converted to MP3.');
    }
  }
  const total = tracks.reduce((n, t) => n + t.playlist.segments.length, 0);
  if (!total) throw new Error('The stream playlist has no segments.');
  if (total > MAX_SEGMENTS) throw new Error('This stream is too long to download.');

  let done = 0;
  const reportFetch = progressReporter(job, 0, job.audioOnly ? 50 : 100);
  const report = () => reportFetch(done / total);

  const loadKey = makeKeyLoader(job);
  const outputs = [];
  for (const track of tracks) {
    const parts = [];
    if (track.playlist.map) parts.push(await fetchBlob(job, track.playlist.map.url, track.playlist.map.byterange));
    parts.push(...await mapLimit(job, track.playlist.segments, CONCURRENCY, async (seg) => {
      const blob = await downloadSegment(job, seg, loadKey);
      done++;
      report();
      return blob;
    }));
    const ext = trackExt(track);
    // A typed Blob stops Chrome from sniffing the bytes and swapping the extension.
    outputs.push({ blob: new Blob(parts, { type: EXT_MIME[ext] }), ext, part: track.part });
  }

  const live = tracks.some((t) => !t.playlist.endList);
  if (job.audioOnly) {
    const mp3 = await globalThis.DownloadIdoMp3.toMp3(outputs[0].blob, { kbps: job.kbps, onProgress: progressReporter(job, 50, 100) });
    return { files: [{ url: toBlobUrl(mp3), ext: 'mp3', part: '' }], live };
  }
  const [video, audio] = outputs;
  const muxed = outputs.length === 2 && video.ext === 'mp4' && audio.ext === 'm4a'
    ? await globalThis.DownloadIdoFmp4.mux(video.blob, audio.blob, { keepOrder: true })
    : null;
  if (muxed) return { files: [{ url: toBlobUrl(muxed), ext: 'mp4', part: '' }], live };
  return { files: outputs.map((o) => ({ url: toBlobUrl(o.blob), ext: o.ext, part: o.part })), live };
}
