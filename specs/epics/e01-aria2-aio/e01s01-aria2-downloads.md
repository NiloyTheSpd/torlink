# Story e01s01: aria2 engine + queue integration for direct URL downloads

**type:** feat
**risk:** P0 (external integration, state persistence)
**context:** infra
**maturity:** 3 (Countable)

## Context

torlink today downloads torrents (webtorrent) and video (yt-dlp), but a direct file
URL has nowhere to go. This story adds aria2 as the third engine: direct http(s)/ftp
links join the same `DownloadQueue` with live progress, speed, connections,
pause/resume/cancel/retry, persistence, restore-with-resume, and completion history.
aria2c is bundled at install on Windows and resolved from the system elsewhere
(verified live: `aria2/aria2` release-1.37.0 ships `aria2-1.37.0-win-64bit-build1.zip`).

## Requirements

#### ADDED: Direct URL downloads via aria2
Typing or pasting a direct file URL (or prefixing `dl `) starts an aria2 download in
the queue, shown in the Downloads view with progress %, speed, connection count, ETA,
pause/resume/cancel/retry/open-folder, and a `url` tag.

#### ADDED: aria2 engine (RPC)
`Aria2Engine` spawns `aria2c --enable-rpc` on a random localhost port with a random
secret, speaks JSON-RPC over HTTP, and maps aria2 statuses (active/waiting/paused/
error/complete/removed) to queue transitions. Binary resolution: bundled
`vendor/aria2/aria2c(.exe)` → system `aria2c`.

#### ADDED: Direct-download persistence and resume
URL items persist in the queue file (magnet: ""), restore across restarts, resume
partial files via aria2 `.aria2` control files, land in Recent history on completion,
and never seed (no magnet).

#### ADDED: Install-time bundling of aria2c (Windows)
`scripts/ensure-aria2.cjs` downloads the official win-64bit build into `vendor/aria2/`
at postinstall; failure warns and never fails the install; other platforms rely on a
system `aria2c`.

## Steps

1. URL helpers: `looksLikeDirectDownload(url)` (file-extension heuristic on the URL
   path) and `downloadNameFromUrl(url)` (decoded basename with safe fallback)
   → verify: `node node_modules/vitest/vitest.mjs run src/download/aria2.test.ts`
2. `Aria2Rpc` client: JSON-RPC over HTTP with token auth, method dispatch
   (getVersion/addUri/tellStatus/pause/unpause/remove/removeDownloadResult), error
   mapping for unknown gid / already-paused / unreachable engine
   → verify: `node node_modules/vitest/vitest.mjs run src/download/aria2.test.ts`
3. `Aria2Engine` lifecycle: lazy spawn with retry on port conflict, readiness ping,
   `add/stats/pause/unpause/remove/destroy`, spawn-arg contract (enable-rpc, secret,
   max-concurrent-downloads=64, file-allocation=none), status→progress mapping
   → verify: `node node_modules/vitest/vitest.mjs run src/download/aria2.test.ts`
4. Queue `addUrl(url, dir)`: deterministic `url:` id, dedupe, maxDownloads cap
   (downloading vs queued), async engine start, failure → `failed` with message
   → verify: `node node_modules/vitest/vitest.mjs run src/download/queue.aria2.test.ts`
5. Queue tick integration: async poll with re-entrancy guard; stats copy
   (progress/speed/peers=connections/eta/name from aria2 file path); transitions
   complete → history + no seeding, error → failed + promote, removed → failed
   → verify: `node node_modules/vitest/vitest.mjs run src/download/queue.aria2.test.ts`
6. Queue controls: pause (RPC pause, frees slot), resume (unpause or re-add when gid
   lost), cancel (remove + removeDownloadResult), remove incl. deleteFiles, retry
   (re-add resumes partial), suspend/destroy
   → verify: `node node_modules/vitest/vitest.mjs run src/download/queue.aria2.test.ts`
7. Persistence + restore: QueueItem.url and HistoryItem.url fields, backward-compatible
   loaders, restore re-adds in-flight URL items and keeps paused/failed as saved
   → verify: `node node_modules/vitest/vitest.mjs run src/download/queue.aria2.test.ts`
8. TUI wiring: submitQuery/pasteFromClipboard route direct URLs (and `dl ` prefix) to
   `queue.addUrl`; store `startUrlDownload`; Downloads view `url` tag + history
   re-download via URL; help overlay note
   → verify: `node node_modules/typescript/bin/tsc --noEmit`

## Verification Script (Step-by-Step)

1. `node scripts/ensure-aria2.cjs` on Windows → `vendor/aria2/aria2c.exe` exists.
2. `node -e` one-liner: spin a local HTTP server serving a 5 MB random file, then
   `queue.addUrl("http://127.0.0.1:PORT/file.bin", tmpdir)`; poll until status
   `completed`; assert the file exists with the right size; kill server.
3. Repeat with a pause → resume mid-download; assert partial `.aria2` file exists and
   resume completes the file.
4. `node node_modules/typescript/bin/tsc --noEmit` and the full vitest suite pass.
5. Manual TUI: type a direct URL in the search box → item appears in Downloads with
   progress; `p` pauses; `p` resumes; `c` cancels; completion lands in Recent.

## Out of scope

- aria2 BitTorrent/magnet support (webtorrent owns torrents + seeding)
- FTP/metalink-specific UI, speed-limit UI, WebSocket RPC, daemonized aria2

## Risks

- Port conflict / aria2c absent → engine fails the item with a clear message, never
  crashes the app (P0, covered by tests).
- RPC length fields are strings — parse with Number() (P0, covered by mapping tests).
- Backward compat of persisted queue/history files (P1, covered by loader tests).
- Windows zip extraction via PowerShell may fail on exotic systems → warn-and-continue
  (P2).
