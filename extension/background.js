// Service worker entry (ES module): context menus and install-time setup.
// Work lives in ./sw/*; importing those modules registers their event listeners at top level.
import { CONTENT_FILES, errorText, notify } from './sw/common.js';
import { downloadAll, resumeBulk } from './sw/bulk.js';
import { downloadMp3 } from './sw/mp3.js';
import { downloadTarget } from './sw/target.js';
import { viewTarget } from './sw/view.js';

const MENU_ONE = 'downloadido-one';
const MENU_VIEW = 'downloadido-view';
const MENU_ALL = 'downloadido-all';
const MENU_MP3 = 'downloadido-mp3';
// Every context except the toolbar-icon menu ('action'), which has no page point to resolve.
const C = chrome.contextMenus.ContextType;
/** @type {[chrome.contextMenus.ContextType, ...chrome.contextMenus.ContextType[]]} */
const MENU_CONTEXTS = [C.PAGE, C.FRAME, C.SELECTION, C.LINK, C.EDITABLE, C.IMAGE, C.VIDEO, C.AUDIO];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ONE, title: 'Download image / video', contexts: MENU_CONTEXTS });
    chrome.contextMenus.create({ id: MENU_VIEW, title: 'View image', contexts: MENU_CONTEXTS });
    chrome.contextMenus.create({ id: MENU_MP3, title: 'Download audio as MP3', contexts: MENU_CONTEXTS });
    chrome.contextMenus.create({ id: MENU_ALL, title: 'Download all images and videos on this page', contexts: MENU_CONTEXTS });
  });
  injectIntoOpenTabs();
});

/**
 * Tabs opened before install/update don't have the detector yet: add it so right-click works
 * without a reload. (Stream capture still needs a reload: it must start before the player.)
 */
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.filter((t) => !t.discarded && t.id !== undefined).map((t) =>
    chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: CONTENT_FILES })
      .catch(() => {}))); // restricted or closing tab: skip it
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleMenuClick(info, tab).catch((e) =>
    notify(info.menuItemId === MENU_VIEW ? 'Could not view' : 'Download failed', errorText(e)));
});

async function handleMenuClick(info, tab) {
  if (!tab || tab.id === undefined || tab.id < 0) return;
  if (info.menuItemId === MENU_ONE) return downloadTarget(info, tab);
  if (info.menuItemId === MENU_VIEW) return viewTarget(info, tab);
  if (info.menuItemId === MENU_MP3) return downloadMp3(info, tab);
  if (info.menuItemId === MENU_ALL) return downloadAll(tab);
}

// Exposed for end-to-end tests (native context menus can't be clicked by automation).
self.DownloadIdo = { handleMenuClick, injectIntoOpenTabs, resumeBulk };
