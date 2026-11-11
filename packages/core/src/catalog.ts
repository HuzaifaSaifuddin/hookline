import { z } from 'zod';
import { searchScore, titleMatchScore, TITLE_MISMATCH_THRESHOLD } from './text.ts';
import type { Hook, Song, Source, SourceStatus } from './types.ts';

/** Schema of one entry in catalog/songs/<language>.json (the canonical, human-editable catalogue). */
export const CatalogEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'kebab-case id'),
    title: z.string().min(1),
    artists: z.array(z.string().min(1)).min(1),
    language: z.string().regex(/^[a-z-]+$/),
    durationSec: z.number().int().positive().optional(),
    hook: z
      .object({
        startSec: z.number().min(0),
        endSec: z.number().positive(),
        source: z.enum(['seed', 'curator', 'crowd', 'default']),
      })
      .refine((h) => h.endSec > h.startSec, 'hook.endSec must be after hook.startSec')
      .optional(),
    energy: z.number().int().min(1).max(10),
    tags: z.array(z.string()),
    sources: z
      .array(z.object({ provider: z.literal('youtube'), id: z.string().regex(/^[A-Za-z0-9_-]{11}$/) }))
      .min(1),
    popularity: z.number().min(0).max(1).optional(),
    popularitySource: z.enum(['derived', 'curator']).optional(),
    provenance: z.object({ origin: z.string(), importedAt: z.string().optional() }),
    /** Curator confirmed the sources are correct despite a fuzzy-title mismatch. */
    verified: z.boolean().optional(),
  })
  .refine((s) => !s.hook || !s.durationSec || s.hook.endSec <= s.durationSec, 'hook ends after song');

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

/** Cached result of checking a provider id (catalog/verification/youtube.json). */
export interface VerificationRecord {
  status: 'ok' | 'unembeddable' | 'unavailable' | 'error';
  title?: string;
  author?: string;
  checkedAt: string;
}

export function entryToSong(entry: CatalogEntry, verification: Record<string, VerificationRecord>): Song {
  const sources: Source[] = entry.sources.map((s) => {
    const v = verification[s.id];
    const status: SourceStatus =
      !v || v.status === 'error' ? 'unverified' : v.status === 'ok' ? 'ok' : v.status;
    const titleMatch =
      entry.verified ? 1 : v?.title ? titleMatchScore(entry.title, v.title) : null;
    return { provider: s.provider, id: s.id, status, titleMatch, providerTitle: v?.title };
  });
  // Order sources best-first: playable before broken, matching title before mismatching.
  sources.sort((a, b) => sourceRank(b) - sourceRank(a));

  const playable = sources.filter((s) => s.status === 'ok' || s.status === 'unverified');
  let review: Song['review'];
  if (playable.length === 0) review = 'no-playable-source';
  else if (playable.every((s) => s.titleMatch !== null && s.titleMatch < TITLE_MISMATCH_THRESHOLD))
    review = 'title-mismatch';

  return {
    id: entry.id,
    title: entry.title,
    artists: entry.artists,
    language: entry.language,
    durationSec: entry.durationSec,
    hook: entry.hook as Hook | undefined,
    energy: entry.energy,
    popularity: entry.popularity ?? 0.3,
    tags: entry.tags,
    sources,
    origin: entry.provenance.origin,
    review,
  };
}

function sourceRank(s: Source): number {
  const statusRank = { ok: 3, unverified: 2, failing: 1, unembeddable: 0, unavailable: 0 }[s.status];
  const match = s.titleMatch === null ? 0.5 : s.titleMatch;
  const mismatchPenalty = s.titleMatch !== null && s.titleMatch < TITLE_MISMATCH_THRESHOLD ? 2 : 0;
  return statusRank * 10 - mismatchPenalty * 10 + match;
}

/** Sources worth trying, in order. */
export function playableSources(song: Song): Source[] {
  return song.sources.filter(
    (s) =>
      (s.status === 'ok' || s.status === 'unverified') &&
      !(s.titleMatch !== null && s.titleMatch < TITLE_MISMATCH_THRESHOLD),
  );
}

/** Medleys/jukeboxes stay searchable but are never auto-played: hooks don't apply to them. */
export function isAutoPlayable(song: Song): boolean {
  return !song.review && !song.tags.includes('medley') && playableSources(song).length > 0;
}

export function artworkUrl(song: Song): string | undefined {
  const src = playableSources(song)[0] ?? song.sources[0];
  return src ? `https://i.ytimg.com/vi/${src.id}/hqdefault.jpg` : undefined;
}

/** In-memory catalogue with lookup and search. ~1k songs => linear scans are sub-millisecond. */
export class Catalog {
  private byId = new Map<string, Song>();

  constructor(songs: Iterable<Song> = []) {
    for (const s of songs) this.byId.set(s.id, s);
  }

  get size(): number {
    return this.byId.size;
  }

  get(id: string): Song | undefined {
    return this.byId.get(id);
  }

  all(): Song[] {
    return [...this.byId.values()];
  }

  upsert(song: Song): void {
    this.byId.set(song.id, song);
  }

  languages(): Array<{ language: string; count: number }> {
    const m = new Map<string, number>();
    for (const s of this.byId.values()) if (isAutoPlayable(s)) m.set(s.language, (m.get(s.language) ?? 0) + 1);
    return [...m].map(([language, count]) => ({ language, count })).sort((a, b) => b.count - a.count);
  }

  search(query: string, opts: { limit?: number; includeUnplayable?: boolean } = {}): Song[] {
    const limit = opts.limit ?? 20;
    const scored: Array<[number, Song]> = [];
    for (const s of this.byId.values()) {
      if (!opts.includeUnplayable && !isAutoPlayable(s)) continue;
      const sc = searchScore(query, s.title, s.artists);
      if (sc > 0) scored.push([sc, s]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].title.localeCompare(b[1].title));
    return scored.slice(0, limit).map(([, s]) => s);
  }

  /** Best single match for a spoken/typed song name ("play kala chashma"). */
  findByName(name: string): Song | undefined {
    const [best] = this.search(name, { limit: 1 });
    return best;
  }
}
