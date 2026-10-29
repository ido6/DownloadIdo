// End-to-end: loads the unpacked extension into Playwright's Chromium, right-clicks real
// elements on fixture pages, triggers the same handler the context menu uses, and checks
// what lands on disk. Native context menus can't be clicked by automation, so the menu
// click itself is simulated via the service worker's exported handleMenuClick.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { makeFixtures } from './make-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const extDir = path.join(root, 'extension');
const siteDir = path.join(here, 'site');
const CDP_PORT = 9334;
const DOWNLOAD_TIMEOUT_MS = 30000;

let mediaDir;
let server;
let port;
let proc;
let browser;
let page;
let sw;
let tmp;
let dlDir;
let keepAlive;
const stats = { hot403: 0, hls403: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const contentType = (f) => ({
  '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4', '.m4s': 'video/iso.segment', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t',
}[path.extname(f)] || 'application/octet-stream');

function serveFile(res, file, transform, { cors = true } = {}) {
  if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
  const body = transform ? transform(fs.readFileSync(file, 'utf8')) : fs.readFileSync(file);
  res.writeHead(200, { 'content-type': contentType(file), ...(cors ? { 'access-control-allow-origin': '*' } : {}) }).end(body);
}

const fromTestPage = (req) => String(req.headers.referer || '').startsWith(`http://localhost:${port}/`);
// Stream segments only load for pages on their own host (an embedded player's frame, not its parent).
const fromSameHost = (req) => String(req.headers.referer || '').startsWith(`http://${req.headers.host}/`);

// A decoy "ad" stream: 60 s long, so it must not be mistaken for a shorter video on the page.
const AD_PLAYLIST = ['#EXTM3U', '#EXT-X-TARGETDURATION:20', ...[0, 1, 2].flatMap((i) => ['#EXTINF:20,', `hls/seg${i}.ts`]), '#EXT-X-ENDLIST'].join('\n');

function startServer() {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    if (p === '/hls.js') return serveFile(res, path.join(root, 'node_modules/hls.js/dist/hls.min.js'));
    if (p === '/noext/photo') return serveFile(res, path.join(mediaDir, 'noext.png'));
    // WordPress-style resized copies; only "wpfull" has a full-size original on the server.
    const wp = { 'wpfull-300x200.jpg': 'small.jpg', 'wpfull.jpg': 'big.jpg', 'wpgone-300x200.jpg': 'small.jpg' };
    if (p.startsWith('/wp-content/uploads/')) return serveFile(res, path.join(mediaDir, wp[p.slice(20)] || 'missing'));
    if (p === '/protected/hot.jpg') {
      // Cross-origin hotlink protection, no CORS: only requests carrying the page's Referer pass.
      if (!fromTestPage(req)) { stats.hot403++; res.writeHead(403).end('no hotlinking'); return; }
      return serveFile(res, path.join(mediaDir, 'hot.jpg'), undefined, { cors: false });
    }
    if (p === '/media/ad.m3u8') return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(AD_PLAYLIST);
    if (p.startsWith('/media/hls/') && !fromSameHost(req)) { stats.hls403++; res.writeHead(403).end(); return; }
    if (p.startsWith('/media/')) return serveFile(res, path.join(mediaDir, p.slice(7)));
    if (p.startsWith('/dl/')) return serveFile(res, path.join(dlDir, p.slice(4))); // downloaded files, for playback checks
    const file = path.join(siteDir, p === '/' ? 'index.html' : p);
    return serveFile(res, file, file.endsWith('.html') ? (t) => t.replaceAll('__PORT__', String(port)) : undefined);
  });
  return new Promise((r) => server.listen(0, () => { port = server.address().port; r(); }));
}

const SW_EVAL_TIMEOUT_MS = 5000; // a stale worker handle hangs instead of rejecting
const SW_ACTION_TIMEOUT_MS = 60000;
let ctx;
let extOrigin;

async function installSpy(worker) {
  await worker.evaluate(() => {
    self.__notes = self.__notes || [];
    chrome.notifications.create = (opts) => { self.__notes.push(opts); };
  });
}

/**
 * The extension's service worker as a live Playwright handle. MV3 workers get stopped and
 * restarted by Chrome; a navigation fires our webRequest listener, which wakes it again.
 */
async function liveWorker() {
  if (sw && !sw.__closed) return sw;
  for (let i = 0; i < 50; i++) {
    const found = ctx.serviceWorkers().find((w) => w.url().startsWith(extOrigin));
    if (found) {
      found.on('close', () => { found.__closed = true; });
      await installSpy(found);
      sw = found;
      return sw;
    }
    if (i % 10 === 0) {
      const waker = await ctx.newPage();
      await waker.goto(`http://localhost:${port}/iframe.html`).catch(() => {});
      await waker.close();
    }
    await sleep(200);
  }
  throw new Error('extension service worker not available');
}

function withTimeout(promise, ms) {
  return Promise.race([promise, sleep(ms).then(() => { throw new Error('service worker evaluate timed out'); })]);
}

/** Read-only evaluation in the worker: retried on a stale/restarted handle. */
async function swEval(fn, arg) {
  for (let attempt = 0; ; attempt++) {
    const worker = await liveWorker();
    try {
      // A restarted worker is a fresh instance: put the notification spy back first.
      await withTimeout(worker.evaluate(() => !!self.__notes).then((has) => has || installSpy(worker)), SW_EVAL_TIMEOUT_MS);
      return await withTimeout(worker.evaluate(fn, arg), SW_EVAL_TIMEOUT_MS);
    } catch (e) {
      if (attempt >= 2 || !/closed|restarted|timed out|Target/i.test(String(e))) throw e;
      if (!/restarted/i.test(String(e))) worker.__closed = true;
    }
  }
}

/** A side-effecting call (menu click): make sure the handle is live, then run it exactly once. */
async function swAction(fn, arg) {
  for (let attempt = 0; ; attempt++) {
    await swEval(() => true);
    try {
      return await withTimeout(sw.evaluate(fn, arg), SW_ACTION_TIMEOUT_MS);
    } catch (e) {
      // The worker restarted under us before the call ran; Chrome does this to idle MV3 workers.
      if (attempt >= 1 || !/restarted/i.test(String(e))) throw e;
    }
  }
}

async function findExtensionOrigin() {
  for (let i = 0; i < 50; i++) {
    for (const w of ctx.serviceWorkers()) {
      if (await w.evaluate(() => !!self.DownloadIdo).catch(() => false)) return w.url().replace(/[^/]*$/, ''); // "chrome-extension://<id>/" (URL.origin is 'null' here)
    }
    await sleep(200);
  }
  throw new Error('extension service worker not found');
}

before(async () => {
  mediaDir = makeFixtures();
  await startServer();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'downloadido-'));
  dlDir = path.join(tmp, 'dl');
  fs.mkdirSync(path.join(tmp, 'ud', 'Default'), { recursive: true });
  fs.mkdirSync(dlDir);
  fs.writeFileSync(path.join(tmp, 'ud', 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: dlDir, prompt_for_download: false } }));

  proc = spawn(chromium.executablePath(), [
    '--headless=new', `--user-data-dir=${path.join(tmp, 'ud')}`, `--remote-debugging-port=${CDP_PORT}`,
    `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run', '--autoplay-policy=no-user-gesture-required',
    // CI Linux runners can't create the user namespaces Chromium's sandbox needs.
    ...(process.env.CI ? ['--no-sandbox'] : []),
    'about:blank',
  ]);
  let chromeOutput = '';
  proc.stderr.on('data', (d) => { chromeOutput = (chromeOutput + d).slice(-4000); });
  for (let i = 0; i < 100 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`).catch(() => null);
    if (!browser) await sleep(200);
  }
  if (!browser) throw new Error(`Chromium did not start:\n${chromeOutput}`);
  ctx = browser.contexts()[0];
  // connectOverCDP renames downloads to GUIDs; restore Chrome's normal behaviour.
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  extOrigin = await findExtensionOrigin();
  // Playwright's evaluate() isn't an extension event, so Chrome would stop the idle
  // worker after 30 s. Real menu clicks are events; calling an extension API keeps it alive here.
  page = await ctx.newPage();
  await liveWorker();
  // The first chrome.downloads call in a brand-new profile can stall for a long time while
  // Chrome sets up its download system; do it once here so tests measure the extension.
  // That first call may never resolve at all, so don't wait for it forever.
  await withTimeout(sw.evaluate(() => chrome.downloads.download({ url: chrome.runtime.getURL('icons/icon16.png'), filename: 'warmup.png' })), 30000)
    .catch(() => {});
  keepAlive = setInterval(() => sw && !sw.__closed && sw.evaluate(() => chrome.runtime.getPlatformInfo()).catch(() => {}), 5000);
});

after(async () => {
  clearInterval(keepAlive);
  await browser?.close().catch(() => {});
  proc?.kill();
  server?.close();
});

// ------------------------------------------------------------------ helpers

async function tabIdFor(url) {
  return swEval((u) => chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url === u).id), url);
}

async function maxDownloadId() {
  return swEval(() => chrome.downloads.search({}).then((a) => a.reduce((m, d) => Math.max(m, d.id), 0)));
}

async function waitForDownloads(afterId, count) {
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const items = await swEval((id) => chrome.downloads.search({})
      .then((a) => a.filter((d) => d.id > id).map((d) => ({ id: d.id, state: d.state, filename: d.filename, error: d.error }))), afterId);
    const done = items.filter((d) => d.state === 'complete');
    if (done.length >= count && !items.some((d) => d.state === 'in_progress')) {
      return done.map((d) => path.relative(dlDir, d.filename).replaceAll('\\', '/'));
    }
    await sleep(250);
  }
  const items = await swEval((id) => chrome.downloads.search({}).then((a) => a.filter((d) => d.id > id)), afterId);
  const seen = items.map((d) => `${d.state}:${d.error || ''}:${path.basename(d.filename)}`).join(', ');
  const state = await swEval(async () => ({
    session: Object.keys(await chrome.storage.session.get(null)),
    contexts: (await chrome.runtime.getContexts({})).map((c) => c.contextType),
    rules: (await chrome.declarativeNetRequest.getSessionRules()).length,
    clickError: self.__clickError || "",
  })).catch((e) => String(e));
  throw new Error(`timed out waiting for ${count} download(s); got [${seen}]; notes ${JSON.stringify(await notes())}; state ${JSON.stringify(state)}`);
}

async function notes() {
  return swEval(() => self.__notes.splice(0));
}

async function rightClick(selector, frameUrlPart) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.waitForTimeout(150); // let hit-testing (incl. cross-process iframes) catch up with the scroll
  const box = await page.locator(selector).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  let frameId = 0;
  if (frameUrlPart) {
    const tabId = await tabIdFor(page.url());
    frameId = await swEval(async ({ tabId, part }) => {
      const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => location.href });
      return res.find((r) => r.result.includes(part)).frameId;
    }, { tabId, part: frameUrlPart });
  }
  return frameId;
}

async function clickMenu(menuItemId, frameId = 0, { wait = true } = {}) {
  const tabId = await tabIdFor(page.url());
  // Pass the real Tab object, as contextMenus.onClicked does. Awaiting the handler inside one
  // DevTools evaluate was flaky: Playwright can drop its worker execution context mid-call
  // ("Service worker restarted") although Chrome's logs show the worker kept running. So the
  // handler is fired, records completion in session storage, and we poll for that.
  const token = `click-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await swAction(async ({ menuItemId, frameId, tabId, token }) => {
    const tab = await chrome.tabs.get(tabId);
    self.DownloadIdo.handleMenuClick({ menuItemId, frameId }, tab)
      .catch((e) => String((e && e.message) || e))
      .then((error) => chrome.storage.session.set({ [token]: { error: error || '' } }));
    return true;
  }, { menuItemId, frameId, tabId, token });
  if (!wait) return;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const done = await swEval((key) => chrome.storage.session.get(key).then((r) => r[key] || null), token);
    if (done) {
      await swEval((key) => chrome.storage.session.remove(key), token);
      if (done.error) throw new Error(`menu handler failed: ${done.error}`);
      return;
    }
    await sleep(100);
  }
  throw new Error('menu handler did not finish');
}

async function downloadOne(selector, { frame, count = 1, menu = 'downloadido-one' } = {}) {
  const start = await maxDownloadId();
  const frameId = await rightClick(selector, frame);
  await clickMenu(menu, frameId);
  return waitForDownloads(start, count).catch((e) => { throw new Error(`${selector}: ${e.message}`); });
}

const sameBytes = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b));
const inDl = (rel) => path.join(dlDir, rel);

async function waitForFrame(part) {
  for (let i = 0; i < 100; i++) {
    const f = page.frames().find((fr) => fr.url().includes(part));
    if (f) return f;
    await sleep(100);
  }
  throw new Error(`frame ${part} not found`);
}

// ------------------------------------------------------------------ menus

test('all context menu items are registered', async () => {
  const ok = await swEval(() => Promise.all([
    chrome.contextMenus.update('downloadido-one', {}),
    chrome.contextMenus.update('downloadido-view', {}),
    chrome.contextMenus.update('downloadido-mp3', {}),
    chrome.contextMenus.update('downloadido-all', {}),
  ]).then(() => true, (e) => String(e)));
  assert.equal(ok, true);
});

// ------------------------------------------------------------------ images

test('images: plain, best-resolution, overlays, backgrounds, shadow DOM, iframe, lazy, links', async () => {
  await page.goto(`http://localhost:${port}/`);
  await page.waitForLoadState('load');
  const cases = [
    ['#plain', 'plain.png'],
    ['#srcset', 'big.jpg'],
    ['#picture', 'pic-big.jpg'],
    ['#overlay', 'overlay.jpg'],
    ['#pe-none', 'pe-none.jpg'],
    ['#bg', 'bg.jpg'],
    ['#pseudo', 'pseudo.jpg'],
    ['#shadow', 'shadow.jpg'],
    ['#lazy', 'lazy.jpg'],
    ['#linked', 'linked-full.jpg'],
    ['#noext', 'photo.png'],
    ['#wp', 'wpfull.jpg'], // resized copy swapped for the full-size original
    ['#wpgone', 'wpgone-300x200.jpg'], // original 404s: keep the copy that exists
  ];
  for (const [selector, expected] of cases) {
    const [file] = await downloadOne(selector);
    assert.equal(file, `DownloadIdo/${expected}`, selector);
  }
  const [framed] = await downloadOne('#frame', { frame: 'iframe.html' });
  assert.equal(framed, 'DownloadIdo/iframe.jpg');
  assert.ok(sameBytes(inDl('DownloadIdo/plain.png'), path.join(mediaDir, 'plain.png')));
  assert.ok(sameBytes(inDl('DownloadIdo/wpfull.jpg'), path.join(mediaDir, 'big.jpg')), 'full-size original, not the thumbnail');
});

test('install/update re-injects a live detector over a dead (invalidated) one', async () => {
  const tabId = await tabIdFor(page.url());
  const probe = (id) => chrome.scripting.executeScript({
    target: { tabId: id, frameIds: [0] },
    func: () => {
      const c = globalThis.DownloadIdoContent;
      return {
        alive: typeof c.isAlive === 'function' && c.isAlive(),
        stale: !!c.stale,
        staleHelpers: !!(globalThis.DownloadIdoUtils.stale || globalThis.DownloadIdoFmp4.stale),
      };
    },
  }).then((r) => r[0].result);
  // Simulate everything an older build left in this isolated world: a detector without
  // isAlive, and its helper libraries.
  await swEval((id) => chrome.scripting.executeScript({
    target: { tabId: id, frameIds: [0] },
    func: () => {
      globalThis.DownloadIdoContent = { stale: true, resolveTarget: () => ({ kind: 'none' }) };
      globalThis.DownloadIdoUtils = { ...globalThis.DownloadIdoUtils, stale: true };
      globalThis.DownloadIdoFmp4 = { ...globalThis.DownloadIdoFmp4, stale: true };
    },
  }), tabId);
  assert.deepEqual(await swEval(probe, tabId), { alive: false, stale: true, staleHelpers: true });
  await swAction(() => self.DownloadIdo.injectIntoOpenTabs());
  assert.deepEqual(await swEval(probe, tabId), { alive: true, stale: false, staleHelpers: false });
  // Injecting the files again (as bulk download does) must not throw in an already-set-up world.
  // The MP3 encoder files are injected on demand, possibly more than once per page.
  const errors = await swEval(async (id) => {
    const files = ['lib/utils.js', 'lib/fmp4.js', 'content/detect.js', 'vendor/lamejs.js', 'lib/mpegts.js', 'lib/mp3.js'];
    const out = [];
    for (let i = 0; i < 2; i++) {
      try {
        const res = await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, files });
        for (const r of res) if (r.error) out.push(String(r.error.message || r.error));
      } catch (e) {
        out.push(String(e.message || e));
      }
    }
    const [check] = await chrome.scripting.executeScript({
      target: { tabId: id, frameIds: [0] },
      func: () => typeof globalThis.DownloadIdoMp3.toMp3 === 'function' && typeof globalThis.lamejs.Mp3Encoder === 'function',
    });
    if (!check.result) out.push('MP3 helpers missing after re-injection');
    return out;
  }, tabId);
  assert.deepEqual(errors, []);
  const [file] = await downloadOne('#plain');
  assert.match(file, /^DownloadIdo\/plain( \(\d+\))?\.png$/);
});

test('a page cannot redirect the download with a synthetic right-click', async () => {
  await rightClick('#plain');
  await page.evaluate(() => {
    const r = document.getElementById('bg').getBoundingClientRect();
    document.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.x + 10, clientY: r.y + 10, bubbles: true }));
  });
  const start = await maxDownloadId();
  await clickMenu('downloadido-one');
  const [file] = await waitForDownloads(start, 1);
  assert.match(file, /^DownloadIdo\/plain( \(\d+\))?\.png$/);
});

test('blob: image is copied out of the page', async () => {
  const [file] = await downloadOne('#blobimg');
  assert.equal(file, 'DownloadIdo/image.png');
  assert.ok(sameBytes(inDl(file), path.join(mediaDir, 'plain.png')));
});

test('cross-origin hotlink-protected image is retried with the page Referer', async () => {
  const [file] = await downloadOne('#hot');
  assert.equal(file, 'DownloadIdo/hot.jpg');
  assert.ok(sameBytes(inDl(file), path.join(mediaDir, 'hot.jpg')));
  console.log(`  (server rejected ${stats.hot403} referer-less request(s) before the fallback)`);
});

// ------------------------------------------------------------------ view

/** The tab the "View image" menu item opened, once it exists. */
async function waitForViewer() {
  for (let i = 0; i < 100; i++) {
    const viewer = ctx.pages().find((p) => p.url().includes('/viewer/viewer.html'));
    if (viewer) return viewer;
    await sleep(100);
  }
  throw new Error('viewer tab did not open');
}

/** Wait for the viewer's image to load and return its bytes. */
async function viewerBytes(viewer) {
  await viewer.waitForFunction(() => {
    const el = document.getElementById('img');
    return el && !el.hidden && el.complete && el.naturalWidth > 0;
  }, null, { timeout: 15000 });
  const b64 = await viewer.evaluate(async () => {
    const el = document.getElementById('img');
    const bytes = new Uint8Array(await (await fetch(el.src)).arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(bin);
  });
  return Buffer.from(b64, 'base64');
}

test('view image: plain picture opens in the viewer, nothing is downloaded', async () => {
  await page.goto(`http://localhost:${port}/`);
  await page.waitForLoadState('load');
  const start = await maxDownloadId();
  await rightClick('#plain');
  await clickMenu('downloadido-view');
  const viewer = await waitForViewer();
  const bytes = await viewerBytes(viewer);
  assert.ok(bytes.equals(fs.readFileSync(path.join(mediaDir, 'plain.png'))), 'viewer shows the same bytes');
  assert.ok(await viewer.isVisible('#full'), 'full-screen button shown');
  await viewer.close();
  assert.equal(await maxDownloadId(), start, 'nothing was downloaded');
});

test('view image: hotlink-protected picture is shown via the Referer fallback', async () => {
  const before403 = stats.hot403;
  await rightClick('#hot');
  await clickMenu('downloadido-view');
  const viewer = await waitForViewer();
  const bytes = await viewerBytes(viewer);
  assert.ok(bytes.equals(fs.readFileSync(path.join(mediaDir, 'hot.jpg'))));
  console.log(`  (server rejected ${stats.hot403 - before403} referer-less request(s) before the viewer fell back)`);
  await viewer.close();
});

test('view image: page-generated (blob) picture is shown', async () => {
  await rightClick('#blobimg');
  await clickMenu('downloadido-view');
  const viewer = await waitForViewer();
  const bytes = await viewerBytes(viewer);
  assert.ok(bytes.equals(fs.readFileSync(path.join(mediaDir, 'plain.png'))));
  await viewer.close();
});

test('view image: a video gives a notice instead of a viewer', async () => {
  const start = await maxDownloadId();
  await notes();
  await rightClick('#mp4');
  await clickMenu('downloadido-view');
  await sleep(1000);
  assert.equal(await maxDownloadId(), start);
  assert.ok(ctx.pages().every((p) => !p.url().includes('/viewer/viewer.html')), 'no viewer tab');
  const [n] = await notes();
  assert.deepEqual([n.title, n.message], ['Images only', 'Videos and audio can be downloaded, not viewed.']);
});

test('direct mp4 video downloads the original file, not the play-button sprite over it', async () => {
  const [file] = await downloadOne('#mp4');
  assert.equal(file, 'DownloadIdo/clip.mp4');
  assert.ok(sameBytes(inDl(file), path.join(mediaDir, 'clip.mp4')));
});

test('empty spot downloads nothing and explains why', async () => {
  const start = await maxDownloadId();
  await notes();
  await rightClick('#empty');
  await clickMenu('downloadido-one');
  await sleep(1000);
  assert.equal(await maxDownloadId(), start);
  const [n] = await notes();
  assert.deepEqual([n.title, n.message], ['Nothing to download', 'No image or video found under the cursor.']);
});

test('download all: every frame, skips tiny images, own subfolder', async () => {
  const start = await maxDownloadId();
  // Don't wait for the handler: if Chrome restarts the worker mid-job, the stored queue is
  // resumed by the new worker, and the downloads below are what counts.
  await clickMenu('downloadido-all', 0, { wait: false });
  const files = await waitForDownloads(start, 16);
  const names = files.map((f) => path.basename(f)).sort();
  for (const f of files) assert.match(f, /^DownloadIdo\/localhost \d{4}-\d\d-\d\d \d\d-\d\d\//);
  for (const expected of ['big.jpg', 'pic-big.jpg', 'bg.jpg', 'pseudo.jpg', 'shadow.jpg', 'iframe.jpg', 'clip.mp4', 'lazy.jpg',
    'linked-full.jpg', 'photo.png', 'hot.jpg', 'wpfull.jpg', 'wpgone-300x200.jpg']) {
    assert.ok(names.includes(expected), `missing ${expected} in ${names.join(', ')}`);
  }
  assert.ok(!names.includes('tiny.png'), 'tiny image should be skipped');
});

test('download all resumes a stored queue, retrying items that were in flight', async () => {
  const base = `http://localhost:${port}/media/`;
  const item = (name) => ({ url: base + name, media: 'image', pageUrl: `http://localhost:${port}/` });
  const start = await maxDownloadId();
  await swEval((queue) => chrome.storage.session.set({ bulkQueue: queue }), {
    subfolder: 'resumed', pending: [item('small.jpg'), item('overlay.jpg')], inflight: [item('bg.jpg')],
    started: 5, failed: 0, skippedStreams: 0,
  });
  await notes();
  await swAction(() => self.DownloadIdo.resumeBulk().then(() => true));
  const files = (await waitForDownloads(start, 3)).sort();
  assert.deepEqual(files, ['DownloadIdo/resumed/bg.jpg', 'DownloadIdo/resumed/overlay.jpg', 'DownloadIdo/resumed/small.jpg']);
  assert.deepEqual(await swEval(() => chrome.storage.session.get('bulkQueue')), {}, 'queue cleared when done');
  const n = (await notes()).find((x) => x.title === 'Downloading page media');
  assert.match(n.message, /^Saving 8 files to Downloads\/DownloadIdo\/resumed\./);
});

// ------------------------------------------------------------------ streams

async function openStream(mode) {
  await page.goto(`http://localhost:${port}/streams.html?mode=${mode}`);
  await page.waitForFunction(() => window.ready !== false, null, { timeout: 20000 });
  assert.equal(await page.evaluate(() => window.ready), true);
}

function ffprobe(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file]));
}

test('HLS stream (hls.js, AES-128) is saved in full from the sniffed playlist', async () => {
  await openStream('hls');
  const [file] = await downloadOne('#v');
  assert.match(file, /^DownloadIdo\/Stream Test( \(\d+\))?\.ts$/);
  const info = ffprobe(inDl(file));
  assert.ok(Math.abs(parseFloat(info.format.duration) - 6) < 0.5, `duration ${info.format.duration}`);
  assert.deepEqual(info.streams.map((s) => s.codec_type).sort(), ['audio', 'video']);
  assert.equal(stats.hls403, 0, 'offscreen requests should carry the page Referer');
});

test('HLS player inside a cross-origin iframe is fetched with the iframe as Referer', async () => {
  await page.goto(`http://localhost:${port}/player.html`);
  const frame = await waitForFrame('streams.html');
  await frame.waitForFunction(() => window.ready !== false, null, { timeout: 20000 });
  assert.equal(await frame.evaluate(() => window.ready), true);
  const before403 = stats.hls403;
  const [file] = await downloadOne('#player', { frame: 'streams.html' });
  assert.match(file, /^DownloadIdo\/Stream Test( \(\d+\))?\.ts$/);
  assert.ok(Math.abs(parseFloat(ffprobe(inDl(file)).format.duration) - 6) < 0.5);
  assert.equal(stats.hls403, before403, 'segments must be requested with the iframe URL as Referer');
});

/** Checks a downloaded file decodes cleanly in ffmpeg AND plays (picture + sound) in Chromium. */
async function assertPlayable(rel, seconds) {
  const file = inDl(rel);
  assert.deepEqual(ffprobe(file).streams.map((s) => s.codec_type).sort(), ['audio', 'video']);
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' }).stderr.trim(), '');
  await page.goto(`http://localhost:${port}/iframe.html`);
  const r = await page.evaluate(async (src) => {
    const v = document.createElement('video');
    v.muted = true;
    v.src = src;
    document.body.append(v);
    await new Promise((ok, fail) => { v.onloadedmetadata = ok; v.onerror = () => fail(new Error(String(v.error && v.error.message))); });
    await v.play();
    await new Promise((ok) => setTimeout(ok, 1000));
    return { duration: v.duration, width: v.videoWidth, audioBytes: v.webkitAudioDecodedByteCount };
  }, `/dl/${rel.split('/').map(encodeURIComponent).join('/')}`);
  assert.ok(Math.abs(r.duration - seconds) < 0.5, `duration ${r.duration}`);
  assert.ok(r.width > 0, 'video decoded');
  assert.ok(r.audioBytes > 0, 'audio decoded');
}

test('fMP4 HLS with separate audio is joined into one playable MP4', async () => {
  await openStream('hls2');
  const [file] = await downloadOne('#v');
  assert.match(file, /^DownloadIdo\/Stream Test( \(\d+\))?\.mp4$/);
  await assertPlayable(file, 6);
});

test('MSE player with separate audio/video buffers is joined into one playable MP4', async () => {
  await openStream('mse2');
  const [file] = await downloadOne('#v');
  assert.match(file, /^DownloadIdo\/Stream Test( \(\d+\))?\.mp4$/);
  await assertPlayable(file, 4);
});

test('a decoy playlist with the wrong length is ignored; MSE capture is used instead', async () => {
  await openStream('mse&ad=1');
  const [file] = await downloadOne('#v');
  assert.match(file, /^DownloadIdo\/Stream Test( \(\d+\))?\.mp4$/);
  assert.ok(sameBytes(inDl(file), path.join(mediaDir, 'frag.mp4')));
});

test('MSE player without a playlist: captured buffers equal the source', async () => {
  await openStream('mse');
  await notes();
  const [file] = await downloadOne('#v');
  assert.match(file, /^DownloadIdo\/Stream Test( \(\d+\))?\.mp4$/);
  assert.ok(sameBytes(inDl(file), path.join(mediaDir, 'frag.mp4')));
  const [n] = await notes();
  assert.equal(n.title, 'Video saved (partial capture)');
});

test('blob-backed video saves the whole blob', async () => {
  await openStream('blob');
  const [file] = await downloadOne('#v');
  assert.match(file, /^DownloadIdo\/Stream Test( \(\d+\))?\.mp4$/);
  assert.ok(sameBytes(inDl(file), path.join(mediaDir, 'clip.mp4')));
});

test('DRM video is refused with a notice', async () => {
  await openStream('drm');
  const start = await maxDownloadId();
  await notes();
  await rightClick('#v');
  await clickMenu('downloadido-one');
  await sleep(1000);
  assert.equal(await maxDownloadId(), start);
  const [n] = await notes();
  assert.equal(n.title, 'Protected video');
});

// ------------------------------------------------------------------ MP3

const MP3_NAME = /\.mp3$/;

/** A downloaded MP3: right codec and length, not silent, and Chromium can play it. */
async function assertMp3(rel, seconds) {
  assert.match(rel, MP3_NAME);
  const file = inDl(rel);
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_name:format=duration', '-of', 'json', file]));
  assert.deepEqual(info.streams.map((s) => s.codec_name), ['mp3']);
  assert.ok(Math.abs(parseFloat(info.format.duration) - seconds) < 0.35, `duration ${info.format.duration}`);
  const vol = /mean_volume: (-?[\d.]+) dB/.exec(spawnSync('ffmpeg', ['-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr);
  assert.ok(parseFloat(vol[1]) > -35, `mean volume ${vol[1]} dB (silent?)`);
  await page.goto(`http://localhost:${port}/iframe.html`);
  const played = await page.evaluate(async (src) => {
    // Played from a Blob, like a file on disk: the size is known (our test server has no Range support).
    const a = new Audio(URL.createObjectURL(await (await fetch(src)).blob()));
    a.muted = true;
    await new Promise((ok, fail) => { a.onloadedmetadata = ok; a.onerror = () => fail(new Error('cannot load')); });
    await a.play();
    await new Promise((ok) => setTimeout(ok, 500));
    return { duration: a.duration, time: a.currentTime };
  }, `/dl/${rel.split('/').map(encodeURIComponent).join('/')}`);
  assert.ok(Math.abs(played.duration - seconds) < 0.5, `browser duration ${played.duration}`);
  assert.ok(played.time > 0, 'plays');
}

async function expectMp3Notice(selector, title) {
  const start = await maxDownloadId();
  await notes();
  await rightClick(selector);
  await clickMenu('downloadido-mp3');
  let n;
  for (let i = 0; i < 40 && !n; i++) {
    await sleep(250);
    [n] = await notes();
  }
  assert.equal(await maxDownloadId(), start, 'nothing downloaded');
  assert.equal(n && n.title, title);
}

test('MP3: from a plain mp4 video and from an <audio> element', async () => {
  await page.goto(`http://localhost:${port}/`);
  await page.waitForLoadState('load');
  const [fromVideo] = await downloadOne('#mp4', { menu: 'downloadido-mp3' });
  await assertMp3(fromVideo, 6);
  await page.goto(`http://localhost:${port}/`);
  await page.waitForLoadState('load');
  const [fromAudio] = await downloadOne('#aud audio', { menu: 'downloadido-mp3' });
  await assertMp3(fromAudio, 4);
});

test('MP3: an MP3 source is saved as-is, not re-encoded', async () => {
  await page.goto(`http://localhost:${port}/`);
  await page.waitForLoadState('load');
  const [file] = await downloadOne('#audmp3 audio', { menu: 'downloadido-mp3' });
  assert.match(file, /^DownloadIdo\/tone( \(\d+\))?\.mp3$/);
  assert.ok(sameBytes(inDl(file), path.join(mediaDir, 'tone.mp3')));
});

test('MP3: an image gives a "no audio" notice', async () => {
  await page.goto(`http://localhost:${port}/`);
  await page.waitForLoadState('load');
  await expectMp3Notice('#plain', 'No audio here');
});

test('MP3: HLS transport stream (AES-128) and fMP4 with a separate audio rendition', async () => {
  await openStream('hls');
  const [fromTs] = await downloadOne('#v', { menu: 'downloadido-mp3' });
  await assertMp3(fromTs, 6);
  await openStream('hls2');
  const [fromFmp4] = await downloadOne('#v', { menu: 'downloadido-mp3' });
  await assertMp3(fromFmp4, 6);
});

test('MP3: page-made streams (MSE with separate audio, and a blob) are converted in the page', async () => {
  await openStream('mse2');
  const [fromMse] = await downloadOne('#v', { menu: 'downloadido-mp3' });
  await assertMp3(fromMse, 4);
  await openStream('blob');
  const [fromBlob] = await downloadOne('#v', { menu: 'downloadido-mp3' });
  await assertMp3(fromBlob, 6);
});

test('MP3: a video-only stream and a DRM video give notices', async () => {
  await openStream('mse');
  await expectMp3Notice('#v', 'Could not save audio');
  await openStream('drm');
  await expectMp3Notice('#v', 'Protected video');
});

// ------------------------------------------------------------------ popup & settings

test('popup lists recent downloads and can clear the list', async () => {
  const popup = await ctx.newPage();
  await popup.goto(`${extOrigin}popup/popup.html`);
  await popup.waitForFunction(() => document.querySelectorAll('#recent .item').length > 0, null, { timeout: 10000 });
  const names = await popup.$$eval('#recent .name', (els) => els.map((e) => e.textContent));
  assert.ok(names.some((n) => n.endsWith('.mp3')), `recent: ${names.slice(0, 5).join(', ')}`);
  assert.ok(names.length <= 50, 'history is capped');
  assert.equal(await popup.isVisible('#empty'), false);
  // Completed files offer Open / Show.
  assert.deepEqual(await popup.$$eval('#recent .item:first-child .actions button', (b) => b.map((x) => x.textContent)), ['Open', 'Show']);
  await popup.click('#clear');
  await popup.waitForSelector('#empty', { state: 'visible' });
  assert.equal(await popup.$$eval('#recent .item', (els) => els.length), 0);
  await popup.close();
});

test('settings page changes the folder and the MP3 bitrate', async () => {
  const options = await ctx.newPage();
  await options.goto(`${extOrigin}options/options.html`);
  await options.waitForFunction(() => document.getElementById('folder').value === 'DownloadIdo');
  await options.fill('#folder', 'My: Media');
  await options.dispatchEvent('#folder', 'change');
  await options.check('input[name="mp3Kbps"][value="128"]');
  await options.waitForFunction(() => document.getElementById('status').textContent === 'Saved');
  assert.equal(await options.textContent('#preview'), 'Downloads/My_ Media/');
  assert.deepEqual(await swEval(() => chrome.storage.sync.get(null)), { folder: 'My_ Media', saveAs: false, mp3Kbps: 128 });
  await options.close();

  try {
    await page.goto(`http://localhost:${port}/`);
    await page.waitForLoadState('load');
    const [image] = await downloadOne('#plain');
    assert.match(image, /^My_ Media\/plain( \(\d+\))?\.png$/);
    const [mp3] = await downloadOne('#mp4', { menu: 'downloadido-mp3' });
    assert.match(mp3, /^My_ Media\/.+\.mp3$/);
    const bitrate = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries',
      'stream=bit_rate', '-of', 'csv=p=0', inDl(mp3)], { encoding: 'utf8' }).trim());
    assert.ok(Math.abs(bitrate - 128000) < 8000, `bit rate ${bitrate}`);
  } finally {
    await swEval(() => chrome.storage.sync.clear());
  }
});
