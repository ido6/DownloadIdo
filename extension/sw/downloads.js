// Saving files into Downloads/DownloadIdo/, with full-size swaps and a hotlink retry.
import { U, errorText, notify } from './common.js';
import { onJobDone, startOffscreenJob } from './offscreen.js';
import { getSettings } from './settings.js';

const SNIFF_TIMEOUT_MS = 5000;
const RETRYABLE_ERROR = /^(SERVER_|NETWORK_)/;

/**
 * Ask the server about a URL without downloading it: does it exist, and what file type is it?
 * @returns {Promise<{ok: boolean, ext: string}>}
 */
async function probeUrl(url, pageUrl) {
  if (!U.isAllowedFetch(url, pageUrl)) return { ok: false, ext: '' };
  const tries = [{ method: 'HEAD' }, { method: 'GET', headers: { Range: 'bytes=0-0' } }]; // some servers reject HEAD
  for (const opts of tries) {
    try {
      const res = await fetch(url, { ...opts, credentials: 'include', signal: AbortSignal.timeout(SNIFF_TIMEOUT_MS) });
      res.body?.cancel();
      if (res.ok) return { ok: true, ext: U.extFromMime(res.headers.get('content-type')) };
    } catch {
      // try the next way
    }
  }
  return { ok: false, ext: '' };
}

/** Swap a known resized image URL for its full-size original, if the original really exists. */
export async function preferFullSize(url, pageUrl) {
  const full = U.fullSizeImageUrl(url);
  if (!full) return { url, ext: '' };
  const probe = await probeUrl(full, pageUrl);
  // Must exist AND be served as an image (a rule could point at a video or a document).
  return probe.ok && U.isImageExt(probe.ext) ? { url: full, ext: probe.ext } : { url, ext: '' };
}

const HISTORY_KEY = 'history';
const HISTORY_SIZE = 50;

/** @type {Promise<unknown>} */
let historyWrites = Promise.resolve();
/** Remember our download ids (newest first) for the toolbar popup. */
function addToHistory(id) {
  historyWrites = historyWrites.then(async () => {
    const { [HISTORY_KEY]: list = [] } = await chrome.storage.local.get(HISTORY_KEY);
    const ids = /** @type {number[]} */ (list);
    await chrome.storage.local.set({ [HISTORY_KEY]: [id, ...ids.filter((x) => x !== id)].slice(0, HISTORY_SIZE) });
  }).catch(() => {});
}

/**
 * Every DownloadIdo download goes through here: applies the "ask where to save" setting
 * (never for bulk, which would open one dialog per file) and records it for the popup.
 */
function startDownload(url, filename, { bulk = false, retry = null } = {}) {
  const start = (async () => {
    const { saveAs } = await getSettings();
    const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: saveAs && !bulk });
    addToHistory(id);
    if (retry) rememberRetry(id, retry);
    return id;
  })();
  starting.add(start);
  start.finally(() => starting.delete(start)).catch(() => {});
  return start;
}

// A fast refusal (403) can reach onChanged before download() has returned the id, i.e.
// before the retry entry exists; onChanged waits for these starts to settle first.
/** @type {Set<Promise<number>>} */
const starting = new Set();

const retries = new Map(); // downloadId -> {url, filename, pageUrl}; mirrored in session storage

function rememberRetry(id, entry) {
  retries.set(id, entry); // synchronously, before onChanged can fire for a fast 403
  chrome.storage.session.set({ [`retry:${id}`]: entry }).catch(() => {});
}

async function takeRetry(id) {
  const key = `retry:${id}`;
  const entry = retries.get(id) || (await chrome.storage.session.get(key))[key];
  retries.delete(id);
  chrome.storage.session.remove(key).catch(() => {});
  return entry;
}

/**
 * Save a URL into the download folder (Downloads/DownloadIdo/ by default). If the server
 * refuses it (hotlink protection), onChanged retries once with the page's Referer.
 */
export async function saveUrl(requestedUrl, { media = 'image', subfolder = '', pageUrl = '' } = {}) {
  const isData = /^data:/i.test(requestedUrl);
  if (!isData && !U.isAllowedFetch(requestedUrl, pageUrl)) throw new Error('That address is not allowed (local network or unsupported link).');
  const best = media === 'image' && !isData ? await preferFullSize(requestedUrl, pageUrl) : { url: requestedUrl, ext: '' };
  const url = best.url;
  const ext = U.extFromUrl(url) || best.ext || (isData ? '' : (await probeUrl(url, pageUrl)).ext) || (media === 'video' ? 'mp4' : 'jpg');
  const { folder } = await getSettings();
  const filename = U.buildDownloadPath({ stem: U.stemFromUrl(url), ext, fallback: media, subfolder, folder });
  const retry = !isData && pageUrl ? { url, filename, pageUrl } : null;
  const id = await startDownload(url, filename, { bulk: Boolean(subfolder), retry });
  return id;
}

/** Save extension/page-made blob URLs (stream exports, HLS output, blob images). */
export async function saveFiles(files, stem, fallback = 'video') {
  const { folder } = await getSettings();
  for (const f of files) {
    const ext = f.ext || U.extFromMime(f.mime) || (fallback === 'image' ? 'png' : 'mp4');
    const name = f.part ? `${stem} (${f.part})` : stem;
    await startDownload(f.url, U.buildDownloadPath({ stem: name, ext, fallback, folder }));
  }
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state && delta.state.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  if (state === 'interrupted') await Promise.allSettled([...starting]);
  await retryIfRefused(delta.id);
});

/**
 * If a download we registered for retry was refused by the server, fetch it again in the
 * offscreen document with the page's Referer (chrome.downloads requests can't have their
 * headers changed, the offscreen document's fetches can). Finished downloads just drop
 * their entry; ones still running are left for onChanged.
 */
async function retryIfRefused(id) {
  const [item] = await chrome.downloads.search({ id });
  if (item && item.state === 'in_progress') return;
  const retry = await takeRetry(id);
  if (!retry || !item || item.state !== 'interrupted' || !RETRYABLE_ERROR.test(item.error || '')) return;
  try {
    await startOffscreenJob({ type: 'fetch', url: retry.url, filename: retry.filename, pageUrl: retry.pageUrl });
  } catch (e) {
    notify('Download blocked', `The site refused the file (${item.error}). ${errorText(e)}`);
  }
}

// A worker that stops between a refusal and its retry loses that onChanged event, so a new
// worker re-checks every retry entry still waiting in session storage.
(async () => {
  const stored = await chrome.storage.session.get(null);
  const ids = Object.keys(stored).filter((k) => k.startsWith('retry:')).map((k) => Number(k.slice(6)));
  for (const id of ids) await retryIfRefused(id);
})().catch(() => {});

onJobDone('fetch', async ({ job, url, error }) => {
  if (error) {
    notify('Download blocked', `The site refused the file. ${error}`);
    return;
  }
  await startDownload(url, job.filename, { bulk: true }); // the user already chose (or skipped) a location
});
