import {
  artworkUrl,
  describeIntent,
  emptyTaste,
  getOccasion,
  hookLength,
  isAutoPlayable,
  mapToPool,
  phaseLabel,
  planQueue,
  playableSources,
  poolEnergyRange,
  resolvePlayWindow,
  seededRng,
  targetEnergy,
  applyIntentPatch,
  type GuestRequest,
  type IntentPatch,
  type PlayWindow,
  type PlayedTrack,
  type QueueItemView,
  type RoomSnapshot,
  type SessionTaste,
  type SetIntent,
  type Song,
  type TrackPick,
  type TrackView,
} from '@hookline/core';
import type { CatalogStore } from './catalog-store.ts';

export const QUEUE_LENGTH = 6;
/** Reactions influence energy for this long. */
const REACTION_WINDOW_MS = 3 * 60_000;
const MAX_PENDING_REQUESTS_PER_GUEST = 3;
const REQUEST_TTL_MS = 60 * 60_000;
const REPEAT_REQUEST_COOLDOWN_MS = 60 * 60_000;

export interface NowPlaying {
  songId: string;
  sourceId: string;
  startedAt: number;
  setOffsetSec: number;
  window: PlayWindow;
  reasons: string[];
  targetEnergy: number;
  requestedBy?: string;
  eventId: number;
}

export interface HistoryEntry extends PlayedTrack {
  requestedBy?: string;
}

export interface Reaction {
  kind: 'fire' | 'love' | 'meh';
  at: number;
  guestId: string;
}

/** Everything that survives a server restart. */
export interface RoomState {
  code: string;
  createdAt: number;
  intent: SetIntent;
  status: 'idle' | 'playing' | 'paused';
  history: HistoryEntry[];
  now: NowPlaying | null;
  lockedNext: (TrackPick & { lockedBy: 'preload' | 'host' }) | null;
  requests: GuestRequest[];
  taste: SessionTaste;
  reactions: Reaction[];
  skipVoters: string[];
  shuffleSalt: number;
}

/** Result of a command, for the transport layer to act on. */
export interface Effects {
  changed: boolean;
  toastAll?: string;
  reply?: { text: string; tone?: 'info' | 'success' | 'warn' };
  commandHost?: 'skip';
}

const NONE: Effects = { changed: false };
const CHANGED: Effects = { changed: true };

/**
 * One party. Pure domain logic over RoomState + the catalogue: no sockets,
 * no timers. The RoomManager owns transport, persistence and broadcasting.
 * `now` is injectable so tests can drive time.
 */
export class Room {
  queue: TrackPick[] = [];

  constructor(
    public state: RoomState,
    private store: CatalogStore,
    private clock: () => number = Date.now,
  ) {
    this.replan();
  }

  static create(code: string, intent: SetIntent, store: CatalogStore, clock: () => number = Date.now): Room {
    return new Room(
      {
        code,
        createdAt: clock(),
        intent: { ...intent, summary: describeIntent(intent) },
        status: 'idle',
        history: [],
        now: null,
        lockedNext: null,
        requests: [],
        taste: emptyTaste(),
        reactions: [],
        skipVoters: [],
        shuffleSalt: 0,
      },
      store,
      clock,
    );
  }

  get code(): string {
    return this.state.code;
  }

  // ---------------------------------------------------------------- planning

  /** Seconds of set time elapsed when the next track will start. */
  nextSlotOffsetSec(): number {
    const n = this.state.now;
    if (n) return n.setOffsetSec + hookLength(n.window);
    const last = this.state.history[this.state.history.length - 1];
    return last ? last.setOffsetSec + 60 : 0;
  }

  liveBias(): number {
    const cutoff = this.clock() - REACTION_WINDOW_MS;
    let fire = 0;
    let meh = 0;
    for (const r of this.state.reactions) {
      if (r.at < cutoff) continue;
      if (r.kind === 'fire') fire++;
      if (r.kind === 'meh') meh++;
    }
    const crowd = Math.max(3, fire + meh);
    return Math.max(-1.5, Math.min(1.5, ((fire - meh * 1.5) / crowd) * 1.5));
  }

  private plannerHistory(): PlayedTrack[] {
    const h: PlayedTrack[] = [...this.state.history];
    const n = this.state.now;
    if (n) {
      const s = this.store.catalog.get(n.songId);
      if (s) h.push({ songId: s.id, startedAt: n.startedAt, setOffsetSec: n.setOffsetSec, energy: s.energy, language: s.language, artists: s.artists });
    }
    return h;
  }

  replan(): void {
    const now = this.clock();
    this.state.requests = this.state.requests.filter((r) => now - r.createdAt < REQUEST_TTL_MS);
    const history = this.plannerHistory();
    const songs = this.store.catalog.all();
    let elapsed = this.nextSlotOffsetSec();
    const picks: TrackPick[] = [];
    const reserved = new Set<string>();
    let requests = this.state.requests;

    const locked = this.state.lockedNext;
    if (locked) {
      const song = this.store.catalog.get(locked.song.id);
      if (song && isAutoPlayable(song) && !this.state.taste.bannedSongIds.includes(song.id)) {
        const fresh = { ...locked, song };
        picks.push(fresh);
        reserved.add(song.id);
        if (locked.requestId) requests = requests.filter((r) => r.id !== locked.requestId);
        history.push({ songId: song.id, startedAt: now, setOffsetSec: elapsed, energy: song.energy, language: song.language, artists: song.artists });
        elapsed += hookLength(resolvePlayWindow(song, this.state.intent.style));
      } else {
        this.state.lockedNext = null;
      }
    }

    const seed = (hash(this.code) + this.state.shuffleSalt * 104729) >>> 0;
    picks.push(
      ...planQueue(
        {
          songs,
          intent: this.state.intent,
          history,
          elapsedSec: elapsed,
          stats: this.store.getStats,
          taste: this.state.taste,
          requests,
          liveBias: this.liveBias(),
          now,
          rng: seededRng(seed),
          jitterSeed: seed,
          reserved,
        },
        QUEUE_LENGTH - picks.length,
      ),
    );
    this.queue = picks;
  }

  // ---------------------------------------------------------------- host commands

  play(): Effects {
    if (this.state.status === 'playing') return NONE;
    this.state.status = 'playing';
    return CHANGED;
  }

  pause(): Effects {
    if (this.state.status !== 'playing') return NONE;
    this.state.status = 'paused';
    return CHANGED;
  }

  /**
   * The host jumped within the current song. Shift startedAt so guests' progress
   * (now - startedAt over the window length) lines up with the new position.
   */
  seek(songId: string, positionSec: number): Effects {
    const n = this.state.now;
    if (!n || n.songId !== songId) return NONE;
    const into = Math.max(0, Math.min(n.window.endSec - n.window.startSec, positionSec - n.window.startSec));
    n.startedAt = this.clock() - into * 1000;
    return CHANGED;
  }

  /** The host started playing `songId` (initial start, auto-transition or skip). */
  started(
    songId: string,
    sourceId: string,
    actualDurationSec?: number,
    previous?: { songId: string; outcome: 'completed' | 'skipped' | 'error'; listenedSec: number },
  ): Effects {
    const song = this.store.catalog.get(songId);
    if (!song) return { changed: false, reply: { text: 'Unknown song', tone: 'warn' } };
    const now = this.clock();

    // Same song re-started with no hand-off (page reload / server restart): a resume, not a new play.
    if (!previous && this.state.now?.songId === songId) {
      this.state.now.sourceId = sourceId;
      this.state.now.startedAt = now;
      this.state.now.window = resolvePlayWindow(song, this.state.intent.style, actualDurationSec);
      this.state.status = 'playing';
      return CHANGED;
    }

    this.finishCurrent(previous);
    if (actualDurationSec) this.store.recordDuration(songId, actualDurationSec);

    const pick = this.queue.find((p) => p.song.id === songId);
    const request =
      this.state.requests.find((r) => r.id === pick?.requestId) ?? this.state.requests.find((r) => r.songId === songId);
    if (request) this.state.requests = this.state.requests.filter((r) => r.id !== request.id);
    this.state.intent.seedSongIds = this.state.intent.seedSongIds.filter((id) => id !== songId);

    const setOffsetSec = this.nextSlotOffsetSec();
    const eventId = this.store.recordPlayStart(this.code, songId, sourceId, this.state.intent.occasion, now);
    this.state.now = {
      songId,
      sourceId,
      startedAt: now,
      setOffsetSec: this.state.history.length === 0 && !previous ? 0 : setOffsetSec,
      window: resolvePlayWindow(song, this.state.intent.style, actualDurationSec),
      reasons: pick?.reasons ?? ['Host pick'],
      targetEnergy: pick?.targetEnergy ?? song.energy,
      requestedBy: request?.requestedBy,
      eventId,
    };
    this.state.status = 'playing';
    this.state.lockedNext = null;
    this.state.skipVoters = [];
    this.replan();
    return CHANGED;
  }

  private finishCurrent(previous?: { songId: string; outcome: 'completed' | 'skipped' | 'error'; listenedSec: number }): void {
    const n = this.state.now;
    if (!n) return;
    const song = this.store.catalog.get(n.songId);
    const outcome = previous && previous.songId === n.songId ? previous.outcome : 'skipped';
    const listened = previous && previous.songId === n.songId ? previous.listenedSec : (this.clock() - n.startedAt) / 1000;
    this.store.recordPlayEnd(n.eventId, n.songId, outcome, listened);
    this.state.history.push({
      songId: n.songId,
      startedAt: n.startedAt,
      setOffsetSec: n.setOffsetSec,
      energy: song?.energy ?? 8,
      language: song?.language ?? '',
      artists: song?.artists ?? [],
      outcome,
      listenedSec: Math.round(listened),
      requestedBy: n.requestedBy,
    });
    if (this.state.history.length > 500) this.state.history.splice(0, this.state.history.length - 500);
    this.state.now = null;
  }

  /** Host began buffering the next track: freeze it so the plan can't change under the crossfade. */
  preloading(songId: string): Effects {
    if (this.state.lockedNext?.song.id === songId) return NONE;
    const pick = this.queue.find((p) => p.song.id === songId);
    if (!pick) return NONE;
    this.state.lockedNext = { ...pick, lockedBy: 'preload' };
    this.replan();
    return CHANGED;
  }

  sourceFailed(songId: string, sourceId: string, code: number): Effects {
    const song = this.store.recordSourceFailure(songId, sourceId, code);
    if (song && !isAutoPlayable(song)) return this.songUnplayable(songId);
    return NONE;
  }

  songUnplayable(songId: string): Effects {
    if (!this.state.taste.bannedSongIds.includes(songId)) this.state.taste.bannedSongIds.push(songId);
    if (this.state.lockedNext?.song.id === songId) this.state.lockedNext = null;
    this.replan();
    return CHANGED;
  }

  energy(delta: number): Effects {
    const before = this.state.intent.energyBias;
    this.state.intent = applyIntentPatch(this.state.intent, { energyBias: before + delta });
    if (this.state.intent.energyBias === before) return { changed: false, reply: { text: delta > 0 ? 'Already at max energy' : 'Already as calm as it gets' } };
    this.state.intent.summary = describeIntent(this.state.intent);
    this.replan();
    return { changed: true, toastAll: delta > 0 ? 'DJ is turning it up 🔥' : 'DJ is bringing it down a notch 🌙' };
  }

  feedback(songId: string, kind: 'like' | 'dislike', who = 'host'): Effects {
    const song = this.store.catalog.get(songId);
    if (!song) return NONE;
    this.store.recordFeedback(this.code, songId, kind, who);
    const t = this.state.taste;
    const sign = kind === 'like' ? 1 : -1;
    for (const a of song.artists) bump(t.artistAffinity, a.toLowerCase(), sign * (kind === 'like' ? 0.5 : 0.7));
    bump(t.languageAffinity, song.language, sign * 0.2);
    for (const tag of song.tags) bump(t.tagAffinity, tag, sign * 0.2);
    if (kind === 'dislike' && !t.bannedSongIds.includes(songId)) t.bannedSongIds.push(songId);
    this.replan();
    return { changed: true, reply: { text: kind === 'like' ? `More like ${song.title} coming up` : `Noted, less like ${song.title}`, tone: 'success' } };
  }

  hookNudge(songId: string, edge: 'start' | 'end', deltaSec: number): Effects {
    this.store.addHookNudge(songId, { edge, deltaSec }, this.code);
    return { changed: false, reply: { text: 'Thanks! Hook feedback saved', tone: 'success' } };
  }

  setIntent(intent: SetIntent): Effects {
    const seedsChanged = intent.seedSongIds.join() !== this.state.intent.seedSongIds.join();
    this.state.intent = { ...intent, summary: describeIntent(intent) };
    // Unlock a preloaded track only if the host explicitly asked for specific songs next.
    if (seedsChanged && this.state.lockedNext?.lockedBy === 'preload') this.state.lockedNext = null;
    this.replan();
    return { changed: true, toastAll: `New vibe: ${this.state.intent.summary}` };
  }

  patchIntent(patch: IntentPatch): Effects {
    return this.setIntent(applyIntentPatch(this.state.intent, patch));
  }

  queueRemove(songId: string): Effects {
    if (!this.state.taste.bannedSongIds.includes(songId)) this.state.taste.bannedSongIds.push(songId);
    this.state.requests = this.state.requests.filter((r) => r.songId !== songId);
    if (this.state.lockedNext?.song.id === songId) this.state.lockedNext = null;
    this.replan();
    return CHANGED;
  }

  playNext(songId: string): Effects {
    const song = this.store.catalog.get(songId);
    if (!song || playableSources(song).length === 0) return { changed: false, reply: { text: 'That song is not playable right now', tone: 'warn' } };
    this.state.taste.bannedSongIds = this.state.taste.bannedSongIds.filter((id) => id !== songId);
    const req = this.state.requests.find((r) => r.songId === songId);
    this.state.lockedNext = {
      song,
      score: 0,
      reasons: req ? [`Requested by ${req.requestedBy}`, 'Host bumped it up'] : ['Host pick'],
      targetEnergy: song.energy,
      requestId: req?.id,
      lockedBy: 'host',
    };
    this.replan();
    return { changed: true, reply: { text: `${song.title} is up next`, tone: 'success' } };
  }

  requestDismiss(requestId: string): Effects {
    const before = this.state.requests.length;
    this.state.requests = this.state.requests.filter((r) => r.id !== requestId);
    if (before === this.state.requests.length) return NONE;
    this.replan();
    return CHANGED;
  }

  reshuffle(): Effects {
    this.state.shuffleSalt++;
    if (this.state.lockedNext?.lockedBy === 'preload') this.state.lockedNext = null;
    this.replan();
    return CHANGED;
  }

  // ---------------------------------------------------------------- guest commands

  request(songId: string, guestId: string, guestName: string): Effects {
    const song = this.store.catalog.get(songId);
    if (!song || !isAutoPlayable(song)) return { changed: false, reply: { text: "Sorry, that one can't be played right now", tone: 'warn' } };
    if (this.state.now?.songId === songId) return { changed: false, reply: { text: "It's playing right now! 🎉" } };
    const now = this.clock();
    const recent = [...this.state.history].reverse().find((h) => h.songId === songId);
    if (recent && now - recent.startedAt < REPEAT_REQUEST_COOLDOWN_MS)
      return { changed: false, reply: { text: `${song.title} played ${Math.round((now - recent.startedAt) / 60000)} min ago. Try something else!`, tone: 'warn' } };
    if (this.state.taste.bannedSongIds.includes(songId) && !this.state.requests.some((r) => r.songId === songId))
      return { changed: false, reply: { text: 'The host skipped that one tonight', tone: 'warn' } };

    const existing = this.state.requests.find((r) => r.songId === songId);
    if (existing) {
      if (existing.voters.includes(guestId)) return { changed: false, reply: { text: 'You already asked for this one' } };
      existing.voters.push(guestId);
      this.replan();
      return { changed: true, reply: { text: `Added your vote for ${song.title}`, tone: 'success' } };
    }
    const mine = this.state.requests.filter((r) => r.voters[0] === guestId).length;
    if (mine >= MAX_PENDING_REQUESTS_PER_GUEST)
      return { changed: false, reply: { text: `You have ${mine} requests waiting. Let those play first!`, tone: 'warn' } };

    this.state.requests.push({ id: `rq_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`, songId, requestedBy: guestName, voters: [guestId], createdAt: now });
    this.replan();
    const pos = this.queue.findIndex((p) => p.song.id === songId);
    return {
      changed: true,
      reply: { text: pos >= 0 ? `${song.title} is queued: ${pos === 0 ? 'up next!' : `about ${pos + 1} songs away`}` : `Request received: the DJ will fit ${song.title} in`, tone: 'success' },
    };
  }

  vote(requestId: string, guestId: string): Effects {
    const r = this.state.requests.find((x) => x.id === requestId);
    if (!r || r.voters.includes(guestId)) return NONE;
    r.voters.push(guestId);
    this.replan();
    return CHANGED;
  }

  react(kind: Reaction['kind'], guestId: string): Effects {
    const now = this.clock();
    // One reaction of each kind per guest per 10s.
    if (this.state.reactions.some((r) => r.guestId === guestId && r.kind === kind && now - r.at < 10_000)) return NONE;
    const biasBefore = this.liveBias();
    this.state.reactions.push({ kind, at: now, guestId });
    this.state.reactions = this.state.reactions.filter((r) => now - r.at < REACTION_WINDOW_MS);
    const n = this.state.now;
    if (n && kind !== 'fire') this.store.recordFeedback(this.code, n.songId, kind, guestId);
    if (n && kind === 'love') {
      const s = this.store.catalog.get(n.songId);
      for (const a of s?.artists ?? []) bump(this.state.taste.artistAffinity, a.toLowerCase(), 0.15);
    }
    if (Math.abs(this.liveBias() - biasBefore) > 0.2) this.replan();
    return CHANGED;
  }

  skipVote(guestId: string, guestCount: number): Effects {
    if (!this.state.now || this.state.skipVoters.includes(guestId)) return NONE;
    this.state.skipVoters.push(guestId);
    if (this.state.skipVoters.length >= skipThreshold(guestCount)) {
      this.state.skipVoters = [];
      return { changed: true, commandHost: 'skip', toastAll: 'The crowd voted to skip ⏭️' };
    }
    return CHANGED;
  }

  // ---------------------------------------------------------------- views

  snapshot(guestCount: number, hostOnline: boolean): RoomSnapshot {
    const s = this.state;
    const occasion = getOccasion(s.intent.occasion);
    const view = (song: Song): TrackView => ({
      id: song.id,
      title: song.title,
      artists: song.artists,
      language: song.language,
      energy: song.energy,
      artwork: artworkUrl(song),
      durationSec: song.durationSec,
      tags: song.tags,
    });
    const queue: QueueItemView[] = this.queue.map((p, i) => {
      const req = this.state.requests.find((r) => r.id === p.requestId);
      return {
        track: view(p.song),
        reasons: p.reasons,
        targetEnergy: p.targetEnergy,
        window: resolvePlayWindow(p.song, s.intent.style),
        sourceIds: playableSources(p.song).map((x) => x.id),
        requestId: p.requestId,
        requestedBy: req?.requestedBy,
        locked: i === 0 && !!s.lockedNext,
      };
    });
    const nowSong = s.now ? this.store.catalog.get(s.now.songId) : undefined;
    const range = poolEnergyRange(this.store.catalog.all(), s.intent, occasion);
    const avgTrackMin = s.intent.style === 'full' ? 4 : s.intent.style === 'quick' ? 0.85 : 1.2;
    const horizon = Math.max(90, Math.ceil(this.nextSlotOffsetSec() / 60) + 45);
    const curve: Array<[number, number]> = [];
    for (let m = 0; m <= horizon; m += 2) {
      const t = mapToPool(targetEnergy(s.intent.arc, m, Math.floor(m / avgTrackMin), 0), range) + s.intent.energyBias;
      curve.push([m, Math.round(Math.max(1, Math.min(10, t)) * 10) / 10]);
    }
    const now = this.clock();
    const recent = s.reactions.filter((r) => now - r.at < REACTION_WINDOW_MS);
    return {
      code: s.code,
      serverTime: now,
      createdAt: s.createdAt,
      status: s.status,
      intent: s.intent,
      intentSummary: s.intent.summary ?? describeIntent(s.intent),
      occasion: { id: occasion.id, name: occasion.name, emoji: occasion.emoji },
      nowPlaying:
        s.now && nowSong
          ? {
              track: view(nowSong),
              reasons: s.now.reasons,
              targetEnergy: s.now.targetEnergy,
              window: s.now.window,
              sourceIds: playableSources(nowSong).map((x) => x.id),
              sourceId: s.now.sourceId,
              startedAt: s.now.startedAt,
              setOffsetSec: s.now.setOffsetSec,
              requestedBy: s.now.requestedBy,
              locked: true,
            }
          : null,
      queue,
      history: s.history
        .slice(-30)
        .reverse()
        .flatMap((h) => {
          const song = this.store.catalog.get(h.songId);
          return song ? [{ track: view(song), startedAt: h.startedAt, outcome: h.outcome, requestedBy: h.requestedBy }] : [];
        }),
      requests: s.requests
        .map((r) => {
          const song = this.store.catalog.get(r.songId);
          return song ? { id: r.id, track: view(song), requestedBy: r.requestedBy, votes: r.voters.length, createdAt: r.createdAt, voters: r.voters } : null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .sort((a, b) => b.votes - a.votes || a.createdAt - b.createdAt),
      guestCount,
      hostOnline,
      energy: {
        phase: phaseLabel({ intent: s.intent, elapsedSec: this.nextSlotOffsetSec(), history: this.plannerHistory() }),
        bias: s.intent.energyBias,
        liveBias: Math.round(this.liveBias() * 10) / 10,
        curve,
        played: [
          ...s.history.map((h) => [Math.round((h.setOffsetSec / 60) * 10) / 10, h.energy] as [number, number]),
          ...(s.now && nowSong ? [[Math.round((s.now.setOffsetSec / 60) * 10) / 10, nowSong.energy] as [number, number]] : []),
        ],
      },
      reactions: {
        fire: recent.filter((r) => r.kind === 'fire').length,
        love: recent.filter((r) => r.kind === 'love').length,
        meh: recent.filter((r) => r.kind === 'meh').length,
      },
      skipVotes: s.skipVoters.length,
      skipThreshold: skipThreshold(guestCount),
      elapsedSec: Math.round(this.nextSlotOffsetSec() - (s.now ? hookLength(s.now.window) : 0)),
    };
  }
}

export function skipThreshold(guestCount: number): number {
  return Math.max(2, Math.ceil(guestCount * 0.4));
}

function bump(m: Record<string, number>, k: string, d: number): void {
  m[k] = Math.max(-3, Math.min(3, (m[k] ?? 0) + d));
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
