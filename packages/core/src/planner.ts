import { targetEnergy, arcTarget, clamp } from './arc.ts';
import { isAutoPlayable } from './catalog.ts';
import { resolvePlayWindow, hookLength } from './hooks.ts';
import { getOccasion, occasionFit, type Occasion } from './occasions.ts';
import type {
  GuestRequest,
  TrackPick,
  PlayedTrack,
  SessionTaste,
  SetIntent,
  Song,
  SongStats,
} from './types.ts';

/**
 * The DJ brain. Selection is a transparent weighted score rather than an LLM
 * call: it runs in well under a millisecond per pick over ~1k songs, costs
 * nothing, is deterministic under a seeded RNG (testable), and every pick can
 * be explained from its score components. AI is used upstream to turn
 * free-form requests into a SetIntent, which this planner then executes.
 */

export interface PlannerContext {
  songs: Song[];
  intent: SetIntent;
  /** Tracks already played (or locked) in this session, oldest first. */
  history: PlayedTrack[];
  /** Seconds into the set at which the next track starts. */
  elapsedSec: number;
  stats?: (songId: string) => SongStats | undefined;
  taste: SessionTaste;
  requests: GuestRequest[];
  /** Short-lived energy bias from crowd reactions (-2..+2), on top of intent.energyBias. */
  liveBias?: number;
  now: number;
  rng: () => number;
  /**
   * When set, each song's random tie-breaker is a hash of (songId, seed)
   * instead of the next rng() value. That makes plans *stable*: re-planning
   * after a track starts (or a reaction arrives) only changes picks whose
   * inputs actually changed, so the visible queue doesn't reshuffle.
   */
  jitterSeed?: number;
  /** Ids already reserved in the queue (not yet in history). */
  reserved?: Set<string>;
}

export const WEIGHTS = {
  fit: 4,
  energy: 3.5,
  smoothJumpPenalty: 0.6, // per energy point beyond 2 vs previous track
  sameArtistLast: 4,
  sameArtistRecent: 1.5, // within last 4
  sameArtistWindow: 0.5, // within last 10
  languageStreak: 0.8, // same language 3+ in a row while multiple languages allowed
  quality: 1.5,
  freshness: 1.5, // played elsewhere in the last 24h
  taste: 1,
  favorArtist: 1.5,
  preferLanguage: 2,
  seed: 8,
  request: 8,
  requestVote: 0.8,
  requestWaitPerMin: 0.15,
  knownHook: 0.3,
  popularity: 1.6, // scaled up at peaks: big moments want songs everyone knows

  jitter: 0.9,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

interface Scored {
  song: Song;
  score: number;
  parts: Record<string, number>;
  request?: GuestRequest;
}

export function phaseLabel(ctx: Pick<PlannerContext, 'intent' | 'elapsedSec' | 'history'>): string {
  const min = ctx.elapsedSec / 60;
  const i = ctx.history.length;
  const now = arcTarget(ctx.intent.arc, min, i);
  const before = arcTarget(ctx.intent.arc, Math.max(0, min - 4), Math.max(0, i - 3));
  if (min < 3 && ctx.intent.arc === 'build') return 'Warming up';
  if (now - before > 0.25) return 'Building up';
  if (before - now > 0.25) return 'Breather';
  if (now >= 9.2) return 'Peak time';
  return 'Cruising';
}

/** Long-term quality in 0..1 with a Bayesian prior of 0.5 (so new songs aren't punished). */
export function qualityScore(s: SongStats | undefined): number {
  if (!s) return 0.5;
  const pos = s.completions + 2 * s.likes;
  const neg = s.earlySkips + 2 * s.dislikes;
  return (pos + 2) / (pos + neg + 4);
}

function scoreSong(
  song: Song,
  ctx: PlannerContext,
  occasion: Occasion,
  target: number,
  request: GuestRequest | undefined,
  relaxFit: boolean,
): Scored | null {
  const { intent, history } = ctx;
  const parts: Record<string, number> = {};
  const lowerArtists = song.artists.map((a) => a.toLowerCase());

  if (intent.avoidArtists.some((a) => lowerArtists.some((x) => x.includes(a.toLowerCase())))) return null;
  if (ctx.taste.bannedSongIds.includes(song.id)) return null;
  // Guest requests may cross the language filter; the host can still veto them.
  if (!request && intent.languages.length > 0 && !intent.languages.includes(song.language)) return null;

  const fit = occasionFit(occasion, song.tags, intent.favorTags);
  if (fit === 0 && !request && !relaxFit && !intent.seedSongIds.includes(song.id)) return null;
  parts.fit = fit * WEIGHTS.fit;

  const energyFit = clamp(1 - Math.abs(song.energy - target) / 3, 0, 1);
  parts.energy = energyFit * WEIGHTS.energy * (request ? 0.4 : 1);

  const prev = history[history.length - 1];
  if (prev) {
    const jump = Math.abs(song.energy - prev.energy);
    if (jump > 2) parts.smooth = -(jump - 2) * WEIGHTS.smoothJumpPenalty;
  }

  let artistPenalty = 0;
  const shares = (t: PlayedTrack) => t.artists.some((a) => lowerArtists.includes(a.toLowerCase()));
  for (let k = 1; k <= Math.min(10, history.length); k++) {
    const t = history[history.length - k]!;
    if (!shares(t)) continue;
    artistPenalty = Math.max(
      artistPenalty,
      k === 1 ? WEIGHTS.sameArtistLast : k <= 4 ? WEIGHTS.sameArtistRecent : WEIGHTS.sameArtistWindow,
    );
  }
  if (artistPenalty && !request) parts.artistRepeat = -artistPenalty;

  if (intent.languages.length !== 1 && !intent.preferLanguages.includes(song.language) && history.length >= 2) {
    const last2 = history.slice(-2);
    if (last2.every((t) => t.language === song.language)) parts.languageStreak = -WEIGHTS.languageStreak;
  }

  const stats = ctx.stats?.(song.id);
  parts.quality = (qualityScore(stats) - 0.5) * 2 * WEIGHTS.quality;
  if (stats?.lastPlayedAt && ctx.now - stats.lastPlayedAt < DAY_MS) {
    parts.freshness = -WEIGHTS.freshness * (1 - (ctx.now - stats.lastPlayedAt) / DAY_MS);
  }

  let taste = 0;
  for (const a of song.artists) taste += ctx.taste.artistAffinity[a.toLowerCase()] ?? 0;
  taste += ctx.taste.languageAffinity[song.language] ?? 0;
  for (const t of song.tags) taste += (ctx.taste.tagAffinity[t] ?? 0) * 0.3;
  if (taste) parts.taste = clamp(taste, -2, 2) * WEIGHTS.taste;

  if (intent.favorArtists.some((a) => lowerArtists.some((x) => x.includes(a.toLowerCase()))))
    parts.favorArtist = WEIGHTS.favorArtist;

  if (intent.preferLanguages.includes(song.language)) parts.preferLanguage = WEIGHTS.preferLanguage;

  if (intent.seedSongIds.includes(song.id)) parts.seed = WEIGHTS.seed;

  if (request) {
    const waitedMin = (ctx.now - request.createdAt) / 60000;
    parts.request =
      WEIGHTS.request + request.voters.length * WEIGHTS.requestVote + Math.min(4, waitedMin * WEIGHTS.requestWaitPerMin);
  }

  parts.popularity = song.popularity * WEIGHTS.popularity * (target >= 9 ? 1.4 : 1);

  if (intent.style !== 'full' && song.hook && song.hook.source !== 'default') parts.knownHook = WEIGHTS.knownHook;

  parts.jitter = (ctx.jitterSeed !== undefined ? hashUnit(song.id, ctx.jitterSeed) : ctx.rng()) * WEIGHTS.jitter;

  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  return { song, score, parts, request };
}

function explain(s: Scored, ctx: PlannerContext, occasion: Occasion, target: number, phase: string): string[] {
  const reasons: Array<[number, string]> = [];
  const p = s.parts;
  const prev = ctx.history[ctx.history.length - 1];
  if (s.request) {
    const extra = s.request.voters.length - 1; // the requester is the first voter
    reasons.push([100, `Requested by ${s.request.requestedBy}${extra > 0 ? ` · +${extra} vote${extra > 1 ? 's' : ''}` : ''}`]);
  }
  if (p.seed) reasons.push([90, 'You asked to open with this']);
  if (!s.request) {
    const arrow = prev ? (s.song.energy > prev.energy ? '↑' : s.song.energy < prev.energy ? '↓' : '→') : '';
    reasons.push([70, `${phase} ${arrow} energy ${s.song.energy}`.replace(/\s+/g, ' ')]);
  }
  if (p.favorArtist) reasons.push([60, `More ${s.song.artists[0]}, as asked`]);
  if ((p.taste ?? 0) > 0.4) reasons.push([55, 'More of what the room liked']);
  if (s.song.popularity >= 0.66 && target >= 9) reasons.push([50, 'Big sing-along for the peak']);
  if ((p.quality ?? 0) > 0.6) reasons.push([45, 'Crowd favourite: rarely skipped']);
  if (p.preferLanguage) reasons.push([42, `${cap(s.song.language)}, as you prefer`]);
  const favTag = s.song.tags.find((t) => ctx.intent.favorTags.includes(t));
  if (favTag) reasons.push([40, `Your ${favTag} vibe`]);
  if (prev && prev.language !== s.song.language && ctx.intent.languages.length !== 1)
    reasons.push([30, `Switching it up: ${cap(s.song.language)}`]);
  if ((p.fit ?? 0) >= WEIGHTS.fit * 0.95) reasons.push([5, `${occasion.name} fit`]);
  if (p.knownHook && reasons.length < 2) reasons.push([1, 'Curated hook: straight to the best part']);
  return reasons.sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, r]) => r);
}

const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

/**
 * Arcs are authored on a 7..10 scale. A given occasion + language slice of the
 * catalogue may only span, say, 8..10 (festival) — so we stretch the arc onto
 * the pool's actual energy range (10th..90th percentile of well-fitting songs),
 * otherwise a "warm-up" target would drag in off-occasion songs.
 */
export function poolEnergyRange(songs: Song[], intent: SetIntent, occasion: Occasion): [number, number] {
  const es: number[] = [];
  for (const s of songs) {
    if (!isAutoPlayable(s)) continue;
    if (intent.languages.length && !intent.languages.includes(s.language)) continue;
    if (occasionFit(occasion, s.tags, intent.favorTags) >= 0.75) es.push(s.energy);
  }
  if (es.length < 8) return [ARC_LO, ARC_HI];
  es.sort((a, b) => a - b);
  const lo = es[Math.floor(es.length * 0.1)]!;
  const hi = es[Math.min(es.length - 1, Math.floor(es.length * 0.9))]!;
  return hi - lo < 1 ? [Math.max(1, hi - 1), hi] : [lo, hi];
}
const ARC_LO = 7;
const ARC_HI = 10;

export function mapToPool(target: number, [lo, hi]: [number, number]): number {
  return lo + ((target - ARC_LO) / (ARC_HI - ARC_LO)) * (hi - lo);
}

const rangeCache = new WeakMap<Song[], Map<string, [number, number]>>();
function cachedRange(songs: Song[], intent: SetIntent, occasion: Occasion): [number, number] {
  const key = `${occasion.id}|${intent.languages.join(',')}|${intent.favorTags.join(',')}`;
  let m = rangeCache.get(songs);
  if (!m) rangeCache.set(songs, (m = new Map()));
  let r = m.get(key);
  if (!r) m.set(key, (r = poolEnergyRange(songs, intent, occasion)));
  return r;
}

/** Choose the single best next song. Returns null only if the catalogue has nothing playable at all. */
export function pickNext(ctx: PlannerContext): TrackPick | null {
  const occasion = getOccasion(ctx.intent.occasion);
  const elapsedMin = ctx.elapsedSec / 60;
  const target = clamp(
    mapToPool(targetEnergy(ctx.intent.arc, elapsedMin, ctx.history.length, 0), cachedRange(ctx.songs, ctx.intent, occasion)) +
      ctx.intent.energyBias +
      (ctx.liveBias ?? 0),
    1,
    10,
  );
  const phase = phaseLabel(ctx);
  const played = new Set(ctx.history.map((h) => h.songId));
  const reserved = ctx.reserved ?? new Set<string>();
  const requestsBySong = new Map(ctx.requests.map((r) => [r.songId, r]));

  // Progressive relaxation: strict -> any tag -> allow repeats (oldest first).
  for (const level of [0, 1, 2] as const) {
    let best: Scored | null = null;
    for (const song of ctx.songs) {
      if (!isAutoPlayable(song)) continue;
      if (level < 2 && (played.has(song.id) || reserved.has(song.id))) continue;
      if (level === 2 && song.id === ctx.history[ctx.history.length - 1]?.songId) continue;
      const scored = scoreSong(song, ctx, occasion, target, requestsBySong.get(song.id), level >= 1);
      if (!scored) continue;
      if (level === 2 && played.has(song.id)) {
        // Prefer whatever was played longest ago.
        const lastIdx = ctx.history.map((h) => h.songId).lastIndexOf(song.id);
        scored.score -= (lastIdx / Math.max(1, ctx.history.length)) * 10;
      }
      if (!best || scored.score > best.score) best = scored;
    }
    if (best) {
      return {
        song: best.song,
        score: Math.round(best.score * 100) / 100,
        reasons: explain(best, ctx, occasion, target, phase),
        targetEnergy: Math.round(target * 10) / 10,
        requestId: best.request?.id,
      };
    }
  }
  return null;
}

/**
 * Plan the next `count` tracks by simulating the set forward. The queue is
 * re-planned whenever something changes (reaction, request, vibe change),
 * so only the very next track is ever "locked".
 */
export function planQueue(ctx: PlannerContext, count: number): TrackPick[] {
  const picks: TrackPick[] = [];
  const history = [...ctx.history];
  const reserved = new Set(ctx.reserved ?? []);
  let elapsed = ctx.elapsedSec;
  let requests = [...ctx.requests];
  for (let i = 0; i < count; i++) {
    const pick = pickNext({ ...ctx, history, elapsedSec: elapsed, reserved, requests });
    if (!pick) break;
    picks.push(pick);
    reserved.add(pick.song.id);
    if (pick.requestId) requests = requests.filter((r) => r.id !== pick.requestId);
    history.push({
      songId: pick.song.id,
      startedAt: ctx.now,
      setOffsetSec: elapsed,
      energy: pick.song.energy,
      language: pick.song.language,
      artists: pick.song.artists,
    });
    elapsed += hookLength(resolvePlayWindow(pick.song, ctx.intent.style));
  }
  return picks;
}

function hashUnit(s: string, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Deterministic PRNG (mulberry32) so plans are reproducible in tests. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
