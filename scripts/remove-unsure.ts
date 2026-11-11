/**
 * Curation (2026-11-12): remove songs whose identity we can't vouch for.
 *
 * Kept: anything whose YouTube upload plainly *is* the song in the title, even with a
 * generic credit ("Traditional" folk songs) or as a named remix.
 * Removed: entries whose uploads don't establish which song they are (generic "mix"/"dhol"
 * titles pointing at unrelated DJ tracks or drum-troupe recordings), whose title differs
 * from the upload in a way we can't confirm, or whose title/artist was filled in by hand
 * rather than stated by the upload.
 *
 * Usage: npx tsx scripts/remove-unsure.ts [--apply]   (dry run by default)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogEntry } from '../packages/core/src/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'catalog/songs');
const apply = process.argv.includes('--apply');

const REMOVE: Record<string, string> = {
  // Generic titles whose uploads are unrelated DJ tracks / soundchecks
  'dj-halgi-mix': 'uploads are unrelated trending DJ tracks',
  'kolhapuri-jatra-mix': 'uploads are three unrelated DJ remixes / soundchecks',
  'halgi-vaje-chaugada': 'uploads are a Radha Khude song and a halgi soundcheck',
  'halgi-vaje-tarri': 'uploads are a halgi mix and a "new halgi track"',
  'koli-dance-mix': 'uploads are two different Koli mashups',
  'pappu-cant-dance-marathi-mix': 'uploads are a troll mix and a DJ battle recording',
  'party-mashup-dj-praveen-nonie': 'uploads are four different party mashups',
  'zingaat-dhol-remix': 'uploads are two different Zingaat mashups, neither a "dhol remix"',
  // Drum-troupe / procession recordings, not songs
  'girgaon-dhol-tasha': 'uploads are recordings of different dhol-tasha troupes',
  'pune-festival-dhol': 'uploads are dhol-tasha troupe recordings',
  'nashikchi-dhol': 'uploads are a live troupe performance and a dhol recording',
  'kalubai-dhol-tasha': 'uploads are a procession recording and two different songs',
  'renuka-mata-gondhal-dhol': 'upload is a recording of a gondhal party',
  'jatra-re-jatra': 'upload is the film\'s background score, not a song',
  // Title doesn't match the upload and we can't confirm it's the same song
  'mangalagaur-geet': 'uploads are a film song and a compilation',
  'nakhvachya-pori': 'uploads are two different songs',
  'zimma-zimma': 'upload is "Zimma Nako Phubdi Nako", a different song',
  'dj-aala-ganpati-pawaala': 'uploads are two different Ganpati songs',
  'tuljabhavani-gondhal-dj': 'uploads are remixes of "Ambabai Gondhalala Ye", a different title',
  'kal-ratri-mala-swapna-padla': 'upload is "Kaal Rateela Sapan Padla": likely the same song, not certain',
  // Title/artist filled in by hand during earlier curation, not stated by the upload
  'tasha-cha-awaj-tarara-jhala-re': 'local upload; artist credit unconfirmed',
  'shakakarte-shivray': 'no artist credited anywhere',
};

const files = new Map<string, CatalogEntry[]>();
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) files.set(f, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const all = [...files.values()].flat();
const missing = Object.keys(REMOVE).filter((id) => !all.some((e) => e.id === id));
let n = 0;
for (const e of all) if (REMOVE[e.id]) {
  n++;
  console.log(`REMOVE ${e.id.padEnd(32)} "${e.title}" — ${REMOVE[e.id]}`);
}
if (missing.length) console.log(`(already removed: ${missing.join(', ')})`);
console.log(`\n${all.length} songs -> ${all.length - n} songs${apply ? '' : '  (dry run; pass --apply to write)'}`);
if (apply) {
  for (const [file, entries] of files) fs.writeFileSync(path.join(dir, file), JSON.stringify(entries.filter((e) => !REMOVE[e.id]), null, 2) + '\n');
  console.log('written');
}
