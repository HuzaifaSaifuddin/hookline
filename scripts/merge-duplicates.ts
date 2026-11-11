/**
 * One-off curation (2026-11-12): no YouTube upload may belong to two songs.
 *
 * In the seed catalogue, 66 uploads were listed under two or more songs (41 groups).
 * Each group was checked by hand against the uploads' real titles:
 *   MERGE  -> the same song entered twice: keep one entry, union the uploads and tags
 *   ASSIGN -> different songs (incl. original vs remake): an upload stays only with the
 *             song it actually is and is removed from the others
 *   UNCLEAR-> an upload that is clearly neither song is removed from all of them
 * Entries left with no uploads are removed.
 *
 * Usage: npx tsx scripts/merge-duplicates.ts [--apply]   (dry run by default)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogEntrySchema, type CatalogEntry } from '../packages/core/src/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'catalog/songs');
const apply = process.argv.includes('--apply');

/** Same song entered twice. `title` optionally fixes the kept entry's spelling. */
const MERGE: Array<{ keep: string; drop: string[]; title?: string }> = [
  { keep: 'duniya-mein-aaye', drop: ['duniya-mein-aayi-ho-to'] },
  { keep: 'jaanam-samjha-karo', drop: ['janam-samjha-karo'] },
  { keep: 'jhoome-jo-pathaan', drop: ['jhoom-jo-pathaan'] },
  { keep: 'muqabala-muqabala', drop: ['muqabla-muqabla'] },
  { keep: 'muqabla', drop: ['muqabla-street-dancer'] },
  { keep: 'navrai-majhe', drop: ['navrai-majhi-marathi'], title: 'Navrai Majhi' },
  { keep: 'saami-saami', drop: ['saami-saami-sunidhi-chauhan'] },
  { keep: 'shut-up-bounce', drop: ['shut-up-and-bounce'] },
  { keep: 'subah-hone-na-de', drop: ['subha-hone-na-de'] },
  { keep: 'tan-tana-tan-tan', drop: ['tan-tana-tan', 'tan-tana-tan-tan-tan-tara'] },
  { keep: 'nauvaari-sanju', drop: ['nauvari'] },
  { keep: 'shendur-lal-chadhayo', drop: ['sindoor-lal-chadhaayo'] },
  { keep: 'zingaat-marathi', drop: ['zingaat-hindi'], title: 'Zingaat' },
  { keep: 'viah', drop: ['viah-jass'] },
];

/** upload id -> the one song it belongs to (removed from every other song). */
const ASSIGN: Record<string, string> = {
  bh2O4oyB1UM: 'bachna-ae-haseeno-title', // 2008 title song, not the 1977 original
  IjBAgWKW12Y: 'brothers-anthem',
  zaCbuB3w0kg: 'firse-machayenge',
  '7tNPxY_ntEA': 'machayenge',
  nvKZ8EETiPE: 'the-humma-song', // remake, not the classic
  '1tVL11ULjYY': 'the-humma-song',
  RRkXXkqNBi0: 'mari-gali',
  yuKvLHXmX5g: 'ravan-ravan',
  qB2j5FhfOd4: 'wahi-karn-hu-mai',
  'S980-z1qx3g': 'shiv-tandav-stotram',
  rtkUMX09qRQ: 'yeh-ladka-hai-allah',
  GP3FIFALPYg: 'aali-thumkat-naar',
  sv6pkrhzR10: 'meri-madhubala',
  zkt7DfOUlyM: 'bring-it-on-marathi',
  UwkOleuVykw: 'baburao-mast-hai',
  zXxE4X8opIE: 'cham-cham-karta-hai',
  sXqqbOIz3VY: 'garja-maharashtra-majha', // "Jai Jai Maharashtra Majha, Garja Maharashtra Majha" (Shahir Sable)
  VNvdKLpCrw4: 'halgi-vaje-tarri',
  '2KaDL9TSja0': 'kombdi-palali',
  '7_eS0qQuNlk': 'roz-roz-navyane',
  '2gGurQsa7dE': 'koligeet-mashup',
  DYGzMVogkWE: 'vesavchi-paru',
  rMMcNTFYVLY: 'majha-bappa',
  '6EI0ruuLx3c': 'mauli-mauli',
  MZlgZmu_q1Q: 'mi-naadkhula',
  M1rUEOcRCZo: 'tu-havishi',
  LMgVnhNpcFc: 'raja-aala',
  iLHEGrNVf5Y: 'born-to-shine',
  NazIhA_VQWI: 'case',
  MtL_V_PZpYg: 'dont-be-shy-dr-zeus',
  'l-_u7SsGYII': 'dont-be-shy-dr-zeus', // "Don't Be Shy" (feat. Rouge), not a song called "Rough"
  lmdLCz4CAeA: 'tera-mera-viah',
};
/** Uploads that are clearly neither of the songs listing them. */
const UNCLEAR = new Set(['2KqAM62Swjk' /* "Majhi Baay Go" */, 'CAjfiInm1Fg' /* generic Shivaji powada */]);

// ---------------------------------------------------------------------------
const files = new Map<string, CatalogEntry[]>();
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) files.set(f, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const byId = new Map<string, CatalogEntry>();
for (const es of files.values()) for (const e of es) byId.set(e.id, e);
const log: string[] = [];
const removed = new Set<string>();

// Upload ids are matched exactly, tolerating '-'/'_' typos in the table above.
const allUploads = new Map<string, string[]>();
for (const e of byId.values()) for (const s of e.sources) allUploads.set(s.id, [...(allUploads.get(s.id) ?? []), e.id]);
const resolveUpload = (id: string) => (allUploads.has(id) ? id : [...allUploads.keys()].find((k) => k.replace(/[-_]/g, '') === id.replace(/[-_]/g, '')));

// 1. merges
for (const m of MERGE) {
  const keep = byId.get(m.keep);
  if (!keep) throw new Error(`merge keep missing: ${m.keep}`);
  for (const d of m.drop) {
    const other = byId.get(d);
    if (!other) continue; // already merged on a previous run
    const before = keep.sources.length;
    for (const s of other.sources) if (!keep.sources.some((x) => x.id === s.id)) keep.sources.push(s);
    keep.tags = [...new Set([...keep.tags, ...other.tags])].sort();
    removed.add(d);
    log.push(`MERGE   ${d.padEnd(30)} -> ${m.keep} (+${keep.sources.length - before} uploads)`);
  }
  if (m.title && keep.title !== m.title) {
    log.push(`RETITLE ${m.keep.padEnd(30)} "${keep.title}" -> "${m.title}"`);
    keep.title = m.title;
  }
}

// 2. assignments + unclear removals
for (const [rawUpload, owner] of Object.entries(ASSIGN)) {
  const upload = resolveUpload(rawUpload);
  // Later curation (scripts/remove-unsure.ts) may have removed the owner and its uploads.
  if (!upload || !byId.has(owner) || removed.has(owner)) continue;
  if (!byId.get(owner)!.sources.some((s) => s.id === upload)) throw new Error(`assign: ${owner} does not list ${upload}`);
  for (const id of allUploads.get(upload)!) {
    if (id === owner || removed.has(id)) continue;
    const e = byId.get(id)!;
    e.sources = e.sources.filter((s) => s.id !== upload);
    log.push(`MOVE    ${upload} from ${id} (stays with ${owner})`);
  }
}
for (const upload of UNCLEAR) {
  for (const id of allUploads.get(upload) ?? []) {
    const e = byId.get(id)!;
    e.sources = e.sources.filter((s) => s.id !== upload);
    log.push(`REMOVE  ${upload} from ${id} (it is neither song)`);
  }
}

// 3. entries left with nothing to play
for (const e of byId.values()) {
  if (removed.has(e.id) || e.sources.length > 0) continue;
  removed.add(e.id);
  log.push(`DROP    ${e.id.padEnd(30)} no uploads left (all belonged to other songs)`);
}

// 4. invariants
const owners = new Map<string, string>();
const problems: string[] = [];
for (const e of byId.values()) {
  if (removed.has(e.id)) continue;
  CatalogEntrySchema.parse(e);
  for (const s of e.sources) {
    if (owners.has(s.id)) problems.push(`upload ${s.id} still shared: ${owners.get(s.id)} & ${e.id}`);
    owners.set(s.id, e.id);
  }
}

console.log(log.join('\n'));
const kept = [...byId.keys()].filter((id) => !removed.has(id)).length;
console.log(`\n${byId.size} songs -> ${kept} songs; shared uploads remaining: ${problems.length}${apply ? '' : '  (dry run; pass --apply to write)'}`);
if (problems.length) {
  console.log(problems.join('\n'));
  process.exit(1);
}

if (apply) {
  for (const [file, entries] of files) {
    const next = entries.filter((e) => !removed.has(e.id)).sort((a, b) => a.id.localeCompare(b.id));
    fs.writeFileSync(path.join(dir, file), JSON.stringify(next, null, 2) + '\n');
  }
  console.log('written');
}
