# DownloadIdo

[![CI](https://github.com/ido6/DownloadIdo/actions/workflows/ci.yml/badge.svg)](https://github.com/ido6/DownloadIdo/actions/workflows/ci.yml)

Chrome extension: right-click any image or video → **Download image / video**.
Files save straight to `Downloads/DownloadIdo/` (no dialog, auto-renamed on clash). Both are changeable in settings.

## Install (unpacked)
Needs Chrome 121 or later.

1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `extension/` folder.
3. Tabs that were already open work straight away for images and plain videos. Reload a tab before saving a streamed video from it (stream capture has to start before the player does).

## What it handles
| Case | How |
|------|-----|
| Normal images | Downloads the largest version: `srcset`, `<picture>`, lazy `data-src`, or a linked full-size image |
| Resized copies on known sites | Swaps in the full-size original for X/Twitter, Wikimedia, Pinterest, Reddit, Imgur, YouTube thumbnails, Unsplash, WordPress and Shopify. It checks the original exists first and keeps the resized copy if not |
| Images under overlays (Instagram-style) | Looks at every layer under the cursor, not just the top one. Real images and videos win over small background icons such as play buttons |
| CSS background images | Reads `background-image`, including `::before` / `::after` |
| Shadow DOM, iframes | Checks open shadow roots and every frame |
| Hotlink-protected files | If the site refuses the download, fetches it again with the page as the Referer |
| Video files (mp4/webm) | Downloads the original file |
| HLS streams (`.m3u8`, hls.js players) | Fetches the full best-quality stream, decrypts AES-128, joins the segments (`.ts` or `.mp4`; separate audio is joined into the same `.mp4`). The stream's length must match the video, so an ad that played earlier isn't saved by mistake |
| Other streaming players (blob/MediaSource) | Saves what the player has loaded, joining separate audio and video into one `.mp4` when both are MP4. Let the video play to the end first for the full file. Capture memory is capped at 512 MB per tab (oldest captures dropped first), and DRM players are never captured |
| DRM video (Netflix, Disney+, Spotify…) | Refused. It can't be downloaded |

**Download audio as MP3** saves the sound of the video or `<audio>` you right-clicked as an
`.mp3` (192 kbps). It works on plain files, HLS streams (only the audio is fetched when the
stream has a separate audio track) and streaming players. MP3 sources are saved as-is, without
re-encoding. Audio is converted in your browser; nothing is uploaded anywhere.

**View image** opens the right-clicked picture (the same full-size version a download would
save) in a full-screen viewer tab without saving it: click for full screen, double-click for
actual size, mouse wheel or +/- to zoom. Hotlink-protected pictures work too.
(Contributed by Eran Sadgan.)

A fourth menu item, **Download all images and videos on this page**, saves everything (images
smaller than 64 px are skipped) into `Downloads/DownloadIdo/<site> <date time>/`.
Streamed videos are skipped there; right-click each one instead.

## Toolbar popup and settings
- Click the toolbar icon for what's running (streams being joined or converted, with progress)
  and your recent DownloadIdo downloads, with **Open** and **Show** for each. **Clear list**
  empties the list; your files stay.
- The gear opens **settings**:
  - **Folder:** the name of the folder inside your downloads folder.
  - **Ask where to save:** asks for each file. "Download all" never asks, so it doesn't open
    one window per file.
  - **MP3 quality:** 128, 192 or 320 kbps.
- The toolbar badge also shows progress on the tab that is saving a stream.

## Limits
- YouTube and similar sites: the capture only gets what has buffered. If the quality changed
  during playback, or the stream isn't MP4 (e.g. WebM), audio and video stay as separate files.
  Downloading may also break the site's terms.
- Live streams: only the part available right now is saved.
- Chrome menus can't be shown per element, so the menu items appear on every right-click.
- A public web page can't make the extension request addresses on your local network (router, `localhost`, and so on). Pages that are themselves on your network still work.
- HLS segments that use `#EXT-X-MAP` more than once (ad splices) aren't joined correctly.
- MP3: up to 60 minutes of audio and 1 GB of input, because the decoded audio is held in
  memory. Streaming players give only what has loaded, as with video.

## Development
```bash
npm install
```
```bash
npm test
```
- `extension/` holds the extension itself (Manifest V3).
  - `background.js`: service worker entry (menus, install-time setup)
  - `sw/`: service-worker modules
    - `target.js`: the right-clicked item
    - `bulk.js`: download all
    - `downloads.js`: saving, full-size swap, hotlink retry
    - `streams.js`: blob/MSE/HLS routing
    - `playlists.js`: HLS sniffing
    - `offscreen.js`: offscreen jobs and Referer rules
  - `content/detect.js`: finds the media under the cursor
  - `content/mse-hook.js`: captures stream data in the page
  - `offscreen/`: HLS download and join, Referer re-fetch
  - `lib/utils.js`: pure helpers
  - `lib/fmp4.js`: joins fragmented-MP4 audio and video
  - `lib/mp3.js`, `lib/mpegts.js`: MP3 conversion, and audio extraction from MPEG-TS
  - `vendor/lamejs.js`: MP3 encoder ([@breezystack/lamejs](https://www.npmjs.com/package/@breezystack/lamejs), LGPL-3.0, license in `vendor/LICENSE-lamejs`)
  - `sw/mp3.js`: the MP3 menu item
  - `sw/settings.js`: settings (`chrome.storage.sync`)
  - `popup/`, `options/`, `ui/theme.css`: toolbar popup, settings page, shared styles
  - `sw/view.js`, `viewer/`: "View image" and its viewer tab
- `npm run typecheck`: `tsc` over the extension's JS (JSDoc and `@types/chrome`).
- `npm run coverage`: coverage for `lib/`.
- Unit tests: `tests/unit` (`node --test`).
- Integration: `tests/integration`. Muxer, MP3 encoder and TS demuxer, checked against real ffmpeg output.
- E2E: `tests/e2e`. Loads the extension into Playwright's Chromium against local fixture
  pages that ffmpeg generates (ffmpeg must be on PATH). It calls the same handler the menu uses.
- Icons: `powershell -File scripts/make-icons.ps1`.
- CI (GitHub Actions) runs the type check and all three test suites on every push.

## License
MIT, see [LICENSE](LICENSE). `extension/vendor/lamejs.js` is a separate work under LGPL-3.0
([license](extension/vendor/LICENSE-lamejs)).
