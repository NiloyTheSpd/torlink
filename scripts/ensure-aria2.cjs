'use strict';

// Downloads the official aria2 Windows build from GitHub Releases so direct
// http(s)/ftp downloads work out of the box after `npm install` / `npx
// torlnk`. npm runs this package's postinstall, which fetches the pinned
// release (aria2 ships no official Linux/macOS binaries, so this script is
// win32-only; other platforms resolve a system `aria2c` instead).
//
// Failure only warns and never fails the install: torlink still runs, and
// direct downloads fall back to a system aria2c.

const { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync, rmSync, openSync, readSync, closeSync } =
  require('node:fs');
const { get } = require('node:https');
const { join } = require('node:path');
const { platform } = require('node:os');
const { execFile } = require('node:child_process');

const VERSION = '1.37.0';
const ZIP_NAME = `aria2-${VERSION}-win-64bit-build1.zip`;
const ASSET_URL = `https://github.com/aria2/aria2/releases/download/release-${VERSION}/${ZIP_NAME}`;

const DIR = join(__dirname, '..', 'vendor', 'aria2');
const TARGET = join(DIR, 'aria2c.exe');
const ZIP_TMP = join(DIR, `${ZIP_NAME}.part`);
const ZIP_FINAL = join(DIR, ZIP_NAME);

// aria2 publishes binaries only for Windows; everywhere else we rely on a
// system aria2c (Homebrew / apt / etc.) and skip bundling entirely.
if (platform() !== 'win32') {
  console.error('torlnk: aria2 is not bundled on this platform; direct downloads use a system aria2c.');
  process.exit(0);
}

if (existsSync(TARGET)) {
  process.exit(0);
}

function download(url, redirects) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) {
          reject(new Error('too many redirects'));
          return;
        }
        resolve(download(new URL(res.headers.location, url).toString(), redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const out = createWriteStream(ZIP_TMP);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GitHub is occasionally unreachable from some networks; retry a few times
// before giving up.
async function downloadWithRetry() {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await download(ASSET_URL, 5);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  throw lastError;
}

// The file must actually be a zip; a proxy error page would parse as garbage.
function isZip(file) {
  try {
    const fd = openSync(file, 'r');
    try {
      const head = Buffer.alloc(4);
      readSync(fd, head, 0, 4, 0);
      return head[0] === 0x50 && head[1] === 0x4b; // "PK"
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

// Expand-Archive is present on every supported Windows; Node has no built-in
// unzip for arbitrary zips.
function extractWithPowerShell() {
  return new Promise((resolve, reject) => {
    const cmd = [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Force -LiteralPath '${ZIP_FINAL}' -DestinationPath '${DIR}'`,
    ];
    execFile('powershell.exe', cmd, { windowsHide: true }, (error) => {
      if (error) reject(new Error(`Expand-Archive: ${error.message}`));
      else resolve();
    });
  });
}

(async () => {
  try {
    mkdirSync(DIR, { recursive: true });
    await downloadWithRetry();
    if (!isZip(ZIP_TMP)) {
      throw new Error('downloaded file is not a zip archive');
    }
    renameSync(ZIP_TMP, ZIP_FINAL);
    await extractWithPowerShell();
    // The win64 build nests its exe under a versioned folder; lift it to the
    // vendor root the engine resolves, then drop the wrapper folder + zip.
    const nested = join(DIR, ZIP_NAME.replace(/\.zip$/, ''), 'aria2c.exe');
    const source = existsSync(nested) ? nested : join(DIR, 'aria2c.exe');
    if (!existsSync(source)) {
      throw new Error(`extraction did not produce ${TARGET}`);
    }
    renameSync(source, TARGET);
    try {
      rmSync(join(DIR, ZIP_NAME.replace(/\.zip$/, '')), { recursive: true, force: true });
      rmSync(ZIP_FINAL, { force: true });
    } catch {
      // Cleanup of the wrapper is cosmetic; the exe is already in place.
    }
    console.error(`torlnk: bundled aria2 (${VERSION}).`);
  } catch (error) {
    try {
      unlinkSync(ZIP_TMP);
    } catch {
      // Nothing to clean up.
    }
    console.error('');
    console.error('torlnk: could not bundle aria2.');
    console.error('Direct downloads will fall back to a system aria2c.');
    console.error(`  ${error.message}`);
    console.error('');
  }
  process.exit(0);
})();
