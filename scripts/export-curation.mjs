#!/usr/bin/env node
/**
 * Folds runtime curation from the app database back into the git-tracked
 * catalogue, so the catalogue grows independently of any one deployment:
 *
 *   - Studio hook edits        -> song.hook = { ..., source: "curator" }
 *   - "Sources are correct"    -> song.verified = true
 *   - Durations from players   -> song.durationSec (only if missing)
 *   - Songs added in the app   -> appended to catalog/songs/<language>.json
 *
 * Crowd nudges stay in the DB (they're statistical, not authoritative).
 * Usage: node --disable-warning=ExperimentalWarning scripts/export-curation.mjs [path/to/hookline.db]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = process.argv[2] ?? path.join(root, 'data', 'hookline.db');
const dir = path.join(root, 'catalog', 'songs');
if (!fs.existsSync(dbFile)) {
  console.error(`No database at ${dbFile}`);
  process.exit(1);
}
const db = new DatabaseSync(dbFile, { readOnly: true });

const files = new Map();
const byId = new Map();
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const songs = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  files.set(f, songs);
  for (const s of songs) byId.set(s.id, s);
}

const changes = { hooks: 0, verified: 0, durations: 0, added: 0 };
for (const r of db.prepare('SELECT song_id, start_sec, end_sec FROM hook_overrides').all()) {
  const s = byId.get(r.song_id);
  if (!s) continue;
  s.hook = { startSec: r.start_sec, endSec: r.end_sec, source: 'curator' };
  changes.hooks++;
}
for (const r of db.prepare('SELECT song_id, verified, duration_sec FROM song_flags').all()) {
  const s = byId.get(r.song_id);
  if (!s) continue;
  if (r.verified && !s.verified) {
    s.verified = true;
    changes.verified++;
  }
  if (r.duration_sec && !s.durationSec) {
    s.durationSec = Math.round(r.duration_sec);
    changes.durations++;
  }
}
for (const r of db.prepare('SELECT entry FROM custom_songs').all()) {
  const e = JSON.parse(r.entry);
  if (byId.has(e.id)) continue;
  const f = `${e.language}.json`;
  if (!files.has(f)) files.set(f, []);
  files.get(f).push(e);
  byId.set(e.id, e);
  changes.added++;
}
for (const [f, songs] of files) {
  songs.sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(path.join(dir, f), JSON.stringify(songs, null, 2) + '\n');
}
console.log('exported', changes, '\nReview with `git diff catalog/` and run `npm run catalog:validate`.');
