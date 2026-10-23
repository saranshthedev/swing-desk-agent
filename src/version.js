// Contract between the running server and the browser page.
//
// The server reads web/ files from disk on every request, but its own code stays in memory
// until restarted. After an update, a still-running old server can therefore serve a new page
// that expects data the old server does not send. Two guards:
//   API_VERSION – bump whenever the page starts relying on new server data (web/app.js checks it)
//   codeChangedSinceStart() – true once any src/ or web/ file is newer than the server process

import { readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_VERSION = 2;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WATCHED = ['src', 'web'].map((d) => join(ROOT, d));
const STARTED = Date.now();

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

let cache = { at: 0, changed: false };
/** Checked at most every 10 seconds; a few dozen small files. */
export function codeChangedSinceStart() {
  if (Date.now() - cache.at > 10_000) {
    let changed = false;
    try {
      changed = WATCHED.some((d) => newestMtime(d) > STARTED);
    } catch {
      changed = false;
    }
    cache = { at: Date.now(), changed };
  }
  return cache.changed;
}
