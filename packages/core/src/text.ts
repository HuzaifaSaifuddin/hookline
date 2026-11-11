/**
 * Text utilities tuned for romanised South-Asian titles, where the same word is
 * spelled many ways ("Chote/Chhote", "Jedha/Jehda", "Mehbooba/Mehabooba").
 * We compare *consonant skeletons*: lower-case, strip diacritics, drop vowels
 * and 'h', collapse doubled letters, fold a few common phonetic swaps.
 */

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function skeleton(word: string): string {
  const s = word
    .replace(/[aeiouyh]/g, '')
    .replace(/w/g, 'v')
    .replace(/q/g, 'k')
    .replace(/z/g, 'j')
    .replace(/(.)\1+/g, '$1');
  // Pure-vowel words ("aa", "o") keep their first letter so they are not lost.
  return s || word.slice(0, 1);
}

/** Words that describe a version of a song rather than the song itself. */
const DESCRIPTORS = new Set([
  'original', 'title', 'track', 'remix', 'retro', 'classic', 'dance', 'mix',
  'version', 'song', 'full', 'video', 'audio', 'official', 'lyrical', 'lyrics',
]);

/**
 * How well a provider's video title matches our song title (0..1).
 * Returns null when the provider title has no Latin text to compare.
 */
export function titleMatchScore(songTitle: string, providerTitle: string): number | null {
  // A jukebox / non-stop upload is many songs; the hook timings cannot apply.
  if (MEDLEY_UPLOAD.test(providerTitle) && !MEDLEY_UPLOAD.test(songTitle)) return 0;
  if (!/[a-z]/i.test(providerTitle)) return null;
  const wanted = tokens(songTitle.replace(/\(.*?\)/g, ' '))
    .filter((w) => !DESCRIPTORS.has(w))
    .map(skeleton);
  if (wanted.length === 0) return 1;
  const have = tokens(providerTitle).map(skeleton);
  const haveJoined = have.join('');
  let hits = 0;
  for (const w of wanted) {
    if (
      have.includes(w) ||
      (w.length >= 2 && have.some((h) => h.startsWith(w))) ||
      (w.length >= 3 && haveJoined.includes(w))
    ) {
      hits++;
    }
  }
  return hits / wanted.length;
}

export const MEDLEY_UPLOAD = /\b(jukebox|non ?stop|nonstop|all songs|back to back)\b/i;

/** Below this, we assume the source is a different song. */
export const TITLE_MISMATCH_THRESHOLD = 0.34;

/**
 * Relevance of a song for a free-text search query (0 = no match).
 * Matches on title (strong) and artists (weaker), tolerant of spelling.
 */
export function searchScore(query: string, title: string, artists: string[]): number {
  const q = tokens(query);
  if (q.length === 0) return 0;
  const qs = q.map(skeleton);
  const t = tokens(title);
  const ts = t.map(skeleton);
  const a = tokens(artists.join(' '));
  const as = a.map(skeleton);
  let score = 0;
  for (let i = 0; i < q.length; i++) {
    const raw = q[i]!;
    const sk = qs[i]!;
    if (t.includes(raw)) score += 3;
    else if (t.some((w) => w.startsWith(raw))) score += 2.5;
    else if (ts.some((w) => w === sk || (sk.length >= 2 && w.startsWith(sk)))) score += 2;
    else if (a.includes(raw) || a.some((w) => w.startsWith(raw))) score += 1.5;
    else if (as.some((w) => w === sk)) score += 1;
    else return 0; // every query word must match something
  }
  // Prefer titles whose start matches the query.
  if (t.join(' ').startsWith(q.join(' '))) score += 2;
  return score / q.length;
}

export function slugify(text: string): string {
  return tokens(text).join('-').slice(0, 80) || 'song';
}
