// Full-screen image viewer for "View image". Reads the payload the service worker stored for
// this tab, fetches the picture (asking the service worker to retry with the page's Referer
// when the site refuses hotlinks) and shows it centered on black. Click = full screen,
// double-click = actual size, wheel = zoom.
'use strict';

const stage = document.getElementById('stage');
const img = /** @type {HTMLImageElement} */ (document.getElementById('img'));
const statusEl = document.getElementById('status');
const bar = document.getElementById('bar');
const nameEl = document.getElementById('name');
const hostEl = document.getElementById('host');
const hint = document.getElementById('hint');
const zoomLabel = document.getElementById('zoom-label');

const MIN_ZOOM = 1; // 1 = fit to window (as fetched, no artificial upscaling)
const MAX_ZOOM = 20;
const WHEEL_STEP = 1.1;
const BUTTON_STEP = 1.25;
const FETCH_TIMEOUT_MS = 60000;

let zoom = 1; // relative to the fit-to-window size
let fitW = 0; // rendered size at zoom 1, measured when first zooming
let fitH = 0;

// ---------------------------------------------------------------- loading

function fail(message) {
  img.hidden = true;
  bar.hidden = true;
  hint.hidden = true;
  statusEl.hidden = false;
  statusEl.className = 'error';
  statusEl.textContent = message;
}

function stemOf(url) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(seg);
  } catch {
    return '';
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

/** Copy bytes into a blob URL this page owns (offscreen blob URLs expire after 10 minutes). */
async function toOwnBlobUrl(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  return URL.createObjectURL(await res.blob());
}

/** Ask the service worker to fetch this tab's picture with the page's Referer (by token only). */
async function fetchWithReferer(token) {
  const reply = await Promise.race([
    chrome.runtime.sendMessage({ type: 'view-fetch', token }),
    new Promise((resolve) => setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)),
  ]);
  if (!reply || reply.error) throw new Error((reply && reply.error) || 'The extension did not answer.');
  return toOwnBlobUrl(reply.url);
}

async function load(payload, token) {
  nameEl.textContent = stemOf(payload.src) || 'image';
  hostEl.textContent = hostOf(payload.src);
  let url = payload.src;
  if (!/^data:/i.test(url)) {
    try {
      url = await toOwnBlobUrl(url); // works for everything except hotlink-protected servers
    } catch (e) {
      // The site refused this page (it is not the image's own page): refetch with its Referer.
      try {
        url = await fetchWithReferer(token);
      } catch (e2) {
        fail(`Could not load this picture (${(e2 && e2.message) || e2}). The site may have blocked it.`);
        return;
      }
    }
  }
  img.onload = () => {
    img.hidden = false;
    bar.hidden = false;
    hint.hidden = false;
    statusEl.hidden = true;
  };
  img.onerror = () => fail('The server did not return a picture.');
  img.src = url;
}

// ---------------------------------------------------------------- zoom & full screen

function applyZoom() {
  if (zoom > 1.001) {
    if (!fitW) { fitW = img.offsetWidth; fitH = img.offsetHeight; }
    img.classList.add('zoomed');
    img.style.width = `${Math.round(fitW * zoom)}px`;
    img.style.height = `${Math.round(fitH * zoom)}px`;
  } else {
    img.classList.remove('zoomed');
    img.style.width = '';
    img.style.height = '';
    fitW = 0;
    fitH = 0;
  }
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
}

function setZoom(next) {
  const before = zoom;
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
  if (zoom === before && zoom !== MIN_ZOOM) return;
  if (zoom === MIN_ZOOM) {
    stage.scrollTo(0, 0);
    if (before === MIN_ZOOM) return; // already at fit
  }
  const centerX = stage.clientWidth / 2;
  const centerY = stage.clientHeight / 2;
  applyZoom();
  if (zoom > 1 && before > 1) {
    // Keep the viewport's center on the same image point.
    stage.scrollLeft = (stage.scrollLeft + centerX) * (zoom / before) - centerX;
    stage.scrollTop = (stage.scrollTop + centerY) * (zoom / before) - centerY;
  }
}

/** Fit-to-window or the picture's actual size (the two states Chrome's own viewer toggles). */
function toggleActualSize() {
  if (zoom > 1.001) { setZoom(1); return; }
  setZoom(1); // (re)measure the fit size
  if (img.naturalWidth && img.naturalWidth > img.offsetWidth) setZoom(img.naturalWidth / img.offsetWidth);
  else if (!img.naturalWidth) setZoom(2); // SVG without intrinsic size: just zoom a little
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const before = zoom;
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, before * (e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP)));
  if (next === before) return;
  if (next === MIN_ZOOM) { setZoom(1); return; } // setZoom also resets the scroll position
  zoom = next;
  applyZoom();
  const factor = zoom / before;
  // Keep the image point under the cursor still (at fit, scroll is 0/0, so this holds too).
  stage.scrollLeft = (stage.scrollLeft + e.clientX) * factor - e.clientX;
  stage.scrollTop = (stage.scrollTop + e.clientY) * factor - e.clientY;
}, { passive: false });

let clickTimer = 0;
img.addEventListener('click', () => {
  if (clickTimer) return; // the second click of a double-click
  clickTimer = setTimeout(() => { clickTimer = 0; toggleFullscreen(); }, 250);
});
img.addEventListener('dblclick', () => {
  clearTimeout(clickTimer);
  clickTimer = 0;
  toggleActualSize();
});

document.getElementById('zoom-in').addEventListener('click', () => setZoom(zoom * BUTTON_STEP));
document.getElementById('zoom-out').addEventListener('click', () => setZoom(zoom / BUTTON_STEP));
document.getElementById('fit').addEventListener('click', () => setZoom(1));
document.getElementById('full').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  document.getElementById('full').title = document.fullscreenElement ? 'Exit full screen (F)' : 'Full screen (F)';
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  else if (e.key === '+' || e.key === '=') setZoom(zoom * BUTTON_STEP);
  else if (e.key === '-') setZoom(zoom / BUTTON_STEP);
  else if (e.key === '0') setZoom(1);
});

// The window resizing with a zoom applied must not keep using the old fit size.
new ResizeObserver(() => {
  if (zoom > 1.001 && img.offsetWidth) {
    const keep = zoom;
    zoom = 1;
    applyZoom();
    fitW = img.offsetWidth;
    fitH = img.offsetHeight;
    zoom = keep;
    applyZoom();
  }
}).observe(stage);

// ---------------------------------------------------------------- start

(async () => {
  const token = new URLSearchParams(location.search).get('v');
  const key = `view:${token}`;
  const stored = await chrome.storage.session.get(key);
  const payload = /** @type {{src: string, referer?: string} | undefined} */ (stored[key]);
  if (!payload || !payload.src) {
    fail('The viewer request expired. Right-click the picture and choose View image again.');
    return;
  }
  // The entry stays until loading ends: the Referer fallback looks it up by token.
  await load(payload, token);
  chrome.storage.session.remove(key);
})();
