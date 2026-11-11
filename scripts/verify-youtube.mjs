#!/usr/bin/env node
/**
 * Verifies YouTube video IDs referenced by the catalogue using YouTube's public
 * oEmbed endpoint (no API key, no scraping, no media download).
 *
 *   200 -> "ok"            public + embeddable (what our iframe player needs)
 *   401 -> "unembeddable"  owner disabled embedding; cannot play in our app
 *   403 -> "unembeddable"  (same family of restriction)
 *   404 -> "unavailable"   private / deleted / never existed
 *   400 -> "unavailable"   malformed id
 *
 * Results are cached in catalog/verification/youtube.json so re-runs only check
 * new or stale ids. Usage:
 *   node scripts/verify-youtube.mjs [--stale-days=30] [--concurrency=6]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const songsDir = path.join(root, 'catalog', 'songs');
const outFile = path.join(root, 'catalog', 'verification', 'youtube.json');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')),
);
const staleDays = Number(args['stale-days'] ?? 30);
const concurrency = Number(args.concurrency ?? 6);
const extraFile = args.ids; // optional: JSON array of ids to check instead of the catalogue

function collectIds() {
  if (extraFile) return JSON.parse(fs.readFileSync(extraFile, 'utf8'));
  const ids = new Set();
  for (const f of fs.readdirSync(songsDir).filter((f) => f.endsWith('.json'))) {
    for (const s of JSON.parse(fs.readFileSync(path.join(songsDir, f), 'utf8'))) {
      for (const src of s.sources ?? []) if (src.provider === 'youtube') ids.add(src.id);
    }
  }
  return [...ids];
}

const cache = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
const now = Date.now();
const todo = collectIds().filter((id) => {
  const c = cache[id];
  return !c || now - Date.parse(c.checkedAt) > staleDays * 86400e3;
});
console.log(`checking ${todo.length} ids (cached: ${Object.keys(cache).length})`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(id, attempt = 0) {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${id}`,
  )}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'catalog-verifier/1.0' } });
    if (res.status === 200) {
      const j = await res.json();
      return { status: 'ok', title: j.title, author: j.author_name };
    }
    if (res.status === 401 || res.status === 403) return { status: 'unembeddable' };
    if (res.status === 404 || res.status === 400) return { status: 'unavailable' };
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    if (attempt < 4) {
      await sleep(1000 * 2 ** attempt);
      return check(id, attempt + 1);
    }
    return { status: 'error', error: String(err.message ?? err) };
  }
}

let done = 0;
async function worker(queue) {
  while (queue.length) {
    const id = queue.shift();
    const r = await check(id);
    cache[id] = { ...r, checkedAt: new Date().toISOString() };
    if (++done % 100 === 0) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(cache, null, 1));
      console.log(`${done}/${todo.length}`);
    }
  }
}
const queue = [...todo];
await Promise.all(Array.from({ length: concurrency }, () => worker(queue)));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(
  outFile,
  JSON.stringify(Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b))), null, 1),
);
const tally = {};
for (const v of Object.values(cache)) tally[v.status] = (tally[v.status] ?? 0) + 1;
console.log('done', tally);
