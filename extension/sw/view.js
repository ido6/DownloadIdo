// "View image": open the right-clicked picture full-screen in a viewer tab, without saving it.
// The viewer first fetches the image itself; when the site refuses (hotlink protection) it asks
// back here and the offscreen document re-fetches it with the page's Referer (same machinery as
// the download retry in downloads.js).
import { U, callContent, errorText, notify } from './common.js';
import { preferFullSize } from './downloads.js';
import { onJobDone, startOffscreenJob } from './offscreen.js';

// A blob: image's bytes cross from the page to the viewer as a data URL through
// chrome.storage.session (10 MB quota), so bigger page-generated images can't be viewed.
const BLOB_MAX_BYTES = 5 * 1024 * 1024;
const VIEW_KEY_PREFIX = 'view:';

export async function viewTarget(info, tab) {
  const frameId = info.frameId || 0;
  let target = null;
  try {
    target = await callContent(tab.id, frameId, 'resolveTarget');
  } catch {
    // restricted page (chrome://, web store, PDF viewer): fall back to Chrome's own info
  }
  if ((!target || target.kind === 'none') && info.srcUrl && /^(https?|data):/i.test(info.srcUrl)) {
    target = { kind: 'url', url: info.srcUrl, media: info.mediaType === 'video' ? 'video' : 'image' };
  }
  if (!target) {
    notify('Reload the page', 'DownloadIdo was installed after this page opened. Reload the page and try again.');
    return;
  }
  const pageUrl = target.pageUrl || info.frameUrl || tab.url || ''; // the frame's URL: what its servers expect as Referer

  if (target.kind === 'none') {
    notify('Nothing to view', target.reason || 'No image found under the cursor.');
    return;
  }
  if (target.kind !== 'url' && target.kind !== 'blob') {
    notify('Images only', 'Streams can be downloaded, not viewed.');
    return;
  }
  if (target.media && target.media !== 'image') {
    notify('Images only', 'Videos and audio can be downloaded, not viewed.');
    return;
  }

  let payload;
  if (target.kind === 'blob') {
    const res = await callContent(tab.id, frameId, 'fetchBlobDataUrl', [target.url, BLOB_MAX_BYTES]);
    if (!res || res.error) throw new Error((res && res.error) || 'The page was closed.');
    payload = { src: res.url, referer: '' };
  } else if (/^data:/i.test(target.url)) {
    payload = { src: target.url, referer: '' };
  } else {
    if (!U.isAllowedFetch(target.url, pageUrl)) throw new Error('That address is not allowed (local network or unsupported link).');
    const best = await preferFullSize(target.url, pageUrl); // the same full-size original Download saves
    payload = { src: best.url, referer: pageUrl };
  }

  const token = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  await chrome.storage.session.set({ [VIEW_KEY_PREFIX + token]: payload });
  await chrome.tabs.create({ url: `${chrome.runtime.getURL('viewer/viewer.html')}?v=${token}` });
}

// ------------------------------------------------------------------ hotlink fallback

/** @type {Map<string, (result: {url?: string, error?: string}) => void>} */
const pendingFetches = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'view-fetch' || !msg.url) return false;
  const token = `vf${Math.random().toString(36).slice(2, 8)}`;
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    pendingFetches.delete(token);
    try { sendResponse(result); } catch { /* the viewer tab went away */ }
  };
  pendingFetches.set(token, finish);
  startOffscreenJob({ type: 'viewfetch', url: msg.url, pageUrl: msg.referer || '', token })
    .catch((e) => finish({ error: errorText(e) }));
  return true; // keep the message channel open for the async answer
});

onJobDone('viewfetch', ({ job, url, error }) => {
  const finish = pendingFetches.get(job.token);
  if (!finish) return;
  finish(error ? { error } : { url });
});
