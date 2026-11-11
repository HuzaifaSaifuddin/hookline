/**
 * Curation (2026-11-11, re-run 2026-11-12): resolve every catalogue entry flagged
 * "needs review" (its YouTube upload is a different song than its title says).
 *
 * Instead of quarantining them, adopt what the upload actually is:
 *   rename -> hand-checked title/artists of the chosen upload; keep only that upload;
 *             clear hook + duration (they were timed for a different song — the DJ uses
 *             its default hook and learns the real duration on first play)
 *   verify -> the entry was right all along (fuzzy-match false positive)
 *   drop   -> upload already exists as another song, is not a single song
 *             (compilation / live / political jingle), or nothing is playable
 *
 * Usage: npx tsx scripts/fix-mismatched-sources.ts [--apply]   (dry run by default)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogEntrySchema, entryToSong, slugify, type CatalogEntry, type VerificationRecord } from '../packages/core/src/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'catalog/songs');
const apply = process.argv.includes('--apply');
const verification: Record<string, VerificationRecord> = JSON.parse(
  fs.readFileSync(path.join(root, 'catalog/verification/youtube.json'), 'utf8'),
);

/** Hand-checked against each upload's real title and channel. */
const RENAME: Record<string, { source: string; title: string; artists: string[] }> = {
  'ashtavinayak-darshan': { source: 'FAzbmaSS9rg', title: 'Shri Ganpati Atharvashirsha', artists: ['Ravindra Sathe'] },
  'banjo-bappa': { source: '5fjuiFx5TwE', title: 'Naad Ninaadala', artists: ['Anand Shinde'] },
  'banu-navari-zali-halgi': { source: '12ZYnEhCkN0', title: 'Khandobachi Karbharin', artists: ['Chandan Kamble'] },
  'maratha-tituka-melvava': { source: 'AxYuN0E7KYc', title: 'Shakakarte Shivray', artists: ['Various Artists'] },
  'bapu-zindabad': { source: 'WRxHjyMpOWo', title: 'Babasahebanchi Ringtone', artists: ['Anand Shinde'] },
  'chhatrapati-title': { source: 'DwFVMXJW5j8', title: 'Paani (Title Track)', artists: ['Shankar Mahadevan'] },
  'deva-tuza-mi-aabhari': { source: 'izQkbF9oz8s', title: 'Devbappa', artists: ['Pravin Koli', 'Yogita Koli'] },
  'dhol-tashyancha-awaaz': { source: 'tpa9p1Oygec', title: 'Tasha Cha Awaj Tarara Jhala Re', artists: ['Sumeet Music'] },
  'dil-ki-tapori': { source: '7gOBcaxQWjs', title: 'Kaata Kirrr', artists: ['Adarsh Shinde'] },
  'garja-maharashtra-akhand': { source: 'XRFBosf_3mU', title: 'Jai Jai Maharashtra', artists: ['Avadhoot Gupte'] },
  'golyachi-pend': { source: 'Ce1uHA-3Tw0', title: 'Hya Hya Dolyanchi Bhuk Kay Jaina (Clap Mix)', artists: ['DJ Slash'] },
  'gori-paan-shalu': { source: 'C_VtOyVbOZA', title: 'Samna Rangnar Aahe', artists: ['Anand Shinde'] },
  'jejuri-khandoba-dhol': { source: 'qj-wRJooZoA', title: 'Aala Malhari Keli Tayari', artists: ['Anand Shinde'] },
  'kahi-tari-bhas-hoto': { source: 'JuIfN8F037E', title: 'Dur Dur', artists: ['Bela Shende', 'Swapnil Bandodkar'] },
  'karla-dongarachi-ekvira': { source: 'z_P2Oqw3GNw', title: 'Dongarachi Aai Go Lekar Tuzhi', artists: ['Anand Panchal'] },
  'kashala-udyachi-baat': { source: 'kdoanJQbXVA', title: 'Kevhatari Pahate (Live)', artists: ['Shrinidhi Ghatate'] },
  'maharashtrachi-hasya-jatra-title': { source: 'Aawlf-Ut2ck', title: 'Spandane', artists: ['Avadhoot Gupte'] },
  'malhari-martand-halgi': { source: 'ysZifwNZ5fY', title: 'Chang Bhala', artists: ['Ajay Gogavale'] },
  'mi-koli-rikshawala': { source: 'x5mjONtE-nk', title: 'Dabun Baghatoy Chiku', artists: ['Anand Shinde'] },
  'new-nahari-gele-ga-baai': { source: '8YpbLqps_w4', title: 'Kunjavanachi Sundar Rani', artists: ['Ajay-Atul'] },
  'padar-varti-khurchi-khali': { source: '1Y2_zfDVIAE', title: 'Gori Gavri Mandavakhali (Dance Mix)', artists: ['H2O Brothers', 'DJ KDM'] },
  'porga-zala-talli': { source: 'S8bBA7RRCHw', title: 'Bhar Chaukat Goli Bar (EDM Remix)', artists: ['SVS Brothers'] },
  'porya-zaala-sharabi': { source: '0cIf3M3vO1Y', title: 'Sundara', artists: ['Adarsh Shinde'] },
  'renuka-mata-gondhal': { source: 'kuCeSP3Ww-s', title: 'Renuka Renuka', artists: ['Anand Shinde'] },
  rickshawala: { source: 'BzJdJCbOyys', title: 'Waat Mazhi Baghtoy Rikshawala', artists: ['Reshma Sonawane'] },
  'sanj-yed-pori': { source: 'ET7JalQFxlM', title: 'Tuzya Priticha Vinchu Chawla', artists: ['Ajay Gogavale'] },
  'shivrajyabhishek-sohala': { source: 'Cm64qYau9Yo', title: 'Shivba Raja', artists: ['Avadhoot Gandhi'] },
  'sunbai-gharaat-aali': { source: 'K7FvVWlFc_E', title: 'Sasuchi Varat Sunechya Darat', artists: ['Suresh Wadkar'] },
  'talli-re-talli': { source: 'OBDe-8K27GU', title: 'Durge Durgat Bhari', artists: ['Ajay Gogavale'] },
  'tithe-padli-kaay': { source: 'BMhjvc-PTyM', title: 'Gawlan: Muka Mar Basala Khali (Shakti Tura)', artists: ['Ramchandra Ghanekar'] },
  'ya-re-ya-saare-ya': { source: 'tgI3i6x_3TY', title: 'Sar Sukhachi Shravani', artists: ['Abhijeet Sawant', 'Bela Shende'] },
  'ya-re-ya-sare-ga': { source: 'oqCpc4qQnQQ', title: 'Sang Na Re Mana', artists: ['Swapnil Bandodkar', 'Nihira Joshi'] },
  'yeg-yeg-yedabai': { source: 'qZglwZH9D_0', title: 'Yedai Maza Jiv', artists: ['Chandan Kamble'] },
  defaulter: { source: 'U2TlQbkog08', title: 'Defend', artists: ['Jordan Sandhu'] },
  'gall-da-kara': { source: 'jD5eZgne4EQ', title: 'Cheek', artists: ['Mankirt Aulakh', 'Karam Brar'] },
  // Flagged after scripts/merge-duplicates.ts returned their correct upload to its rightful song:
  'pori-tu-tar-chand-ahes': { source: 'RPrLbwx-Mgg', title: 'Majh First Love', artists: ['Raj Irmali', 'Sonali Sonawane'] },
};
/** Correct all along — the title matcher was fooled ("Mehabooba KGF 2" vs upload "Mehabooba"). */
const VERIFY = new Set(['mehabooba-kgf-2']);
/** Not a single song: compilations, live streams, political jingles, generic "DJ songs" uploads. */
const NOT_A_SONG = new Set([
  'daru-chadli-re', 'dhingana', 'dolby-beat-marathi', 'gsb-seva-mandal-ganpati', 'marathi-dj-songs-2026', 'mi-punha-yein',
  // after merge-duplicates.ts: party anthem, non-stop mix, radio-show episode
  'aapan-marathi', 'koligeet-tarri', 'torana-powada',
]);

type Action = { file: string; id: string; kind: 'rename' | 'verify' | 'drop' | 'CONFLICT'; reason: string; entry?: CatalogEntry };
const files = new Map<string, CatalogEntry[]>();
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) files.set(f, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const all = [...files.entries()].flatMap(([file, es]) => es.map((e) => ({ file, e, song: entryToSong(CatalogEntrySchema.parse(e), verification) })));
const healthy = all.filter((x) => !x.song.review);
const takenIds = new Set(healthy.map((x) => x.e.id));
const takenSources = new Map<string, string>();
for (const x of healthy) for (const s of x.e.sources) takenSources.set(s.id, x.e.id);
const takenTitles = new Map(healthy.map((x) => [slugify(x.e.title), x.e.id]));

const actions: Action[] = [];
for (const { file, e, song } of all) {
  if (!song.review) continue;
  const ok = song.sources.filter((s) => s.status === 'ok');
  if (VERIFY.has(e.id)) {
    actions.push({ file, id: e.id, kind: 'verify', reason: 'correct all along; confirmed', entry: { ...e, verified: true } });
  } else if (RENAME[e.id]) {
    const r = RENAME[e.id]!;
    const id = slugify(r.title);
    const problem =
      !ok.some((s) => s.id === r.source) ? `chosen upload ${r.source} is not playable` :
      takenSources.has(r.source) ? `upload already used by "${takenSources.get(r.source)}"` :
      takenIds.has(id) || takenTitles.has(slugify(r.title)) ? `"${r.title}" already in catalogue as "${takenTitles.get(slugify(r.title)) ?? id}"` : null;
    if (problem) {
      actions.push({ file, id: e.id, kind: 'CONFLICT', reason: problem });
      continue;
    }
    takenIds.add(id);
    takenSources.set(r.source, id);
    const { hook: _h, durationSec: _d, verified: _v, ...rest } = e;
    const entry: CatalogEntry = { ...rest, id, title: r.title, artists: r.artists, sources: [{ provider: 'youtube', id: r.source }] };
    CatalogEntrySchema.parse(entry);
    actions.push({ file, id: e.id, kind: 'rename', reason: `"${e.title}" -> "${r.title}" — ${r.artists.join(', ')}`, entry });
  } else if (NOT_A_SONG.has(e.id)) {
    actions.push({ file, id: e.id, kind: 'drop', reason: `not a single song ("${(ok[0]?.providerTitle ?? '').slice(0, 55)}")` });
  } else if (ok.length === 0) {
    actions.push({ file, id: e.id, kind: 'drop', reason: 'no playable upload' });
  } else {
    const dup = ok.map((s) => takenSources.get(s.id)).find(Boolean) ?? ok.map((s) => takenTitles.get(slugify(s.providerTitle ?? ''))).find(Boolean);
    actions.push({ file, id: e.id, kind: dup ? 'drop' : 'CONFLICT', reason: dup ? `its upload is already the song "${dup}"` : 'unhandled: add to RENAME/NOT_A_SONG' });
  }
}

for (const a of actions) console.log(`${a.kind.padEnd(8)} ${a.id.padEnd(34)} ${a.reason}`);
const n = (k: Action['kind']) => actions.filter((a) => a.kind === k).length;
console.log(`\n${n('rename')} renamed, ${n('verify')} confirmed, ${n('drop')} dropped, ${n('CONFLICT')} conflicts${apply ? '' : '  (dry run; pass --apply to write)'}`);
if (n('CONFLICT') > 0) {
  console.log('Resolve conflicts before applying.');
  process.exit(apply ? 1 : 0);
}

if (apply) {
  for (const [file, entries] of files) {
    const byId = new Map(actions.filter((a) => a.file === file).map((a) => [a.id, a]));
    if (byId.size === 0) continue;
    const next = entries.flatMap((e) => {
      const a = byId.get(e.id);
      return !a ? [e] : a.kind === 'drop' ? [] : [a.entry!];
    });
    next.sort((x, y) => x.id.localeCompare(y.id));
    fs.writeFileSync(path.join(dir, file), JSON.stringify(next, null, 2) + '\n');
  }
  console.log('written');
}
