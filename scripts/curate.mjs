#!/usr/bin/env node
/**
 * Rule-based curation pass over catalog/songs/*.json. Idempotent; every rule is
 * listed here so curation decisions are reviewable in git history.
 *
 *  1. Devotional tracks (aarti, jaap, mantra, bhajan...) are not party/wedding
 *     music: tag `devotional`, strip party-type tags. They power the Festival occasion.
 *  2. Gondhal is folk-devotional but danced to at Maharashtrian events: add
 *     `devotional` + `festival`, keep its party tags.
 *  3. Jukeboxes / non-stop mixes / "all songs" uploads are not single songs; a
 *     hook-based DJ cannot play them well: tag `medley` (never auto-played).
 *  4. `popularity` (0..1) is derived from how many alternate uploads the seed
 *     catalogue lists (its best-known hits have 5), unless a
 *     curator already set it explicitly (`popularitySource: "curator"`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'catalog/songs');
const verification = JSON.parse(fs.readFileSync(path.join(root, 'catalog/verification/youtube.json'), 'utf8'));

const DEVOTIONAL = /\b(aarti|arti|jaap|mantra|mantr|bhajan|ashtakam|chalisa|stotra|naam smaran|atharvashirsha|bhaktigeet|abhang)\b/i;
const GONDHAL = /\bgondhal/i;
const MEDLEY = /\b(jukebox|non ?stop|nonstop|all songs|dj songs 20\d\d|roadshow mix|back to back)\b/i;
const PARTY_TAGS = new Set(['wedding', 'party', 'late-night', 'workout', 'birthday', 'baraat', 'sangeet', 'mehendi']);

const log = { devotional: [], gondhal: [], medley: [] };
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const file = path.join(dir, f);
  const songs = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const s of songs) {
    const providerTitles = s.sources.map((x) => verification[x.id]?.title ?? '').join(' | ');
    const tags = new Set(s.tags);
    if (DEVOTIONAL.test(s.title) || (DEVOTIONAL.test(providerTitles) && !GONDHAL.test(s.title))) {
      if (!tags.has('devotional')) log.devotional.push(s.id);
      for (const t of [...tags]) if (PARTY_TAGS.has(t)) tags.delete(t);
      tags.add('devotional');
      tags.add('festival');
    } else if (GONDHAL.test(s.title)) {
      if (!tags.has('festival')) log.gondhal.push(s.id);
      tags.add('devotional');
      tags.add('festival');
    }
    // Only the song's own title decides; a jukebox *upload* of a normal song is
    // handled per-source by the core matcher (see MEDLEY_UPLOAD in text.ts).
    tags.delete('medley');
    if (MEDLEY.test(s.title)) {
      log.medley.push(s.id);
      tags.add('medley');
    }
    s.tags = [...tags].sort();
    if (s.popularitySource !== 'curator') {
      s.popularity = Math.round(Math.max(0, Math.min(1, (s.sources.length - 2) / 3)) * 100) / 100;
      s.popularitySource = 'derived';
    }
  }
  fs.writeFileSync(file, JSON.stringify(songs, null, 2) + '\n');
}
for (const [k, v] of Object.entries(log)) console.log(`${k}: ${v.length}${v.length ? ' — ' + v.join(', ') : ''}`);
