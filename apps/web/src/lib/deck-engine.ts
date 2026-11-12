import type { QueueItemView } from '@hookline/core';
import { createPlayer, describeYTError, loadYouTubeApi, YTState, type YTPlayer } from './youtube.ts';

/**
 * Two-deck hook player.
 *
 * Timeline of one transition (hook style, 6s crossfade):
 *
 *   current: ──────[hook_start ........................ hook_end]
 *                                  ^ T-25s: pre-roll next track MUTED on the
 *                                    standby deck, then pause it. This surfaces
 *                                    dead/blocked sources while there's still
 *                                    time to fall back to another upload.
 *                                                   ^ T-6s: crossfade
 *   next:                                           [hook_start ..........
 *
 * The crossfade is equal-power (out = cos θ, in = sin θ), so perceived loudness
 * stays constant through the blend instead of dipping in the middle.
 *
 * The engine owns timing; the server owns *what* plays. The engine reads the
 * latest queue through `getQueue()` at decision points, and tells the server
 * what actually happened (started, preloading, source failures).
 */

export type Outcome = 'completed' | 'skipped' | 'error';

export interface EngineCallbacks {
  getQueue(): QueueItemView[];
  /** A track that was playing before a reload/restart, to resume first. */
  getResumeItem?(): QueueItemView | undefined;
  onStarted(item: QueueItemView, sourceId: string, actualDurationSec: number | undefined, previous?: { songId: string; outcome: Outcome; listenedSec: number }): void;
  onPreloading(songId: string): void;
  onSourceFailed(songId: string, sourceId: string, code: number): void;
  onSongUnplayable(songId: string): void;
  onChange(state: EngineState): void;
  onEmpty(): void;
  log?(msg: string): void;
}

export interface EngineState {
  status: 'loading-api' | 'idle' | 'starting' | 'playing' | 'paused' | 'error';
  activeDeck: 'A' | 'B';
  current?: QueueItemView;
  sourceId?: string;
  position: number;
  window?: { startSec: number; endSec: number };
  duration?: number;
  crossfade: number; // 0..1 progress, 0 when not fading
  incoming?: QueueItemView;
  needsGesture: boolean;
  error?: string;
}

type DeckStatus = 'empty' | 'loading' | 'ready' | 'playing' | 'paused' | 'failed';

interface Deck {
  id: 'A' | 'B';
  player?: YTPlayer;
  ready: boolean;
  item?: QueueItemView;
  sourceIdx: number;
  status: DeckStatus;
  /** Why we're loading: to play now, or to pre-roll for a transition. */
  purpose: 'play' | 'preroll';
  window?: { startSec: number; endSec: number };
  duration?: number;
  loadTimer?: ReturnType<typeof setTimeout>;
}

const PRELOAD_LEAD_SEC = 25;
const LOAD_TIMEOUT_MS = 12_000;
const SKIP_FADE_SEC = 2.5;
const TICK_MS = 200;

export class DeckEngine {
  private decks: Record<'A' | 'B', Deck>;
  private active: 'A' | 'B' = 'A';
  private master = 100;
  private fade: { from: 'A' | 'B'; to: 'A' | 'B'; start: number; dur: number; outcome: Outcome; listened: number; started: boolean } | null = null;
  private fadeTimer?: ReturnType<typeof setInterval>;
  private tickTimer?: ReturnType<typeof setInterval>;
  private status: EngineState['status'] = 'loading-api';
  private needsGesture = false;
  private error?: string;
  private destroyed = false;
  private triedSongIds = new Set<string>();

  constructor(
    elA: HTMLElement,
    elB: HTMLElement,
    private cb: EngineCallbacks,
    private crossfadeSec = 6,
  ) {
    this.decks = {
      A: { id: 'A', ready: false, sourceIdx: 0, status: 'empty', purpose: 'play' },
      B: { id: 'B', ready: false, sourceIdx: 0, status: 'empty', purpose: 'play' },
    };
    loadYouTubeApi()
      .then(() => {
        if (this.destroyed) return;
        for (const [id, el] of [['A', elA], ['B', elB]] as const) {
          const deck = this.decks[id];
          deck.player = createPlayer(el, {
            onReady: () => {
              deck.ready = true;
              if (this.decks.A.ready && this.decks.B.ready) {
                this.status = 'idle';
                this.emit();
              }
            },
            onStateChange: (s) => this.onState(deck, s),
            onError: (code) => this.onError(deck, code),
          });
        }
      })
      .catch((err: Error) => {
        this.status = 'error';
        this.error = err.message;
        this.emit();
      });
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  setCrossfade(sec: number): void {
    this.crossfadeSec = sec;
  }

  get ready(): boolean {
    return this.decks.A.ready && this.decks.B.ready;
  }

  // -------------------------------------------------------------- public controls

  /** Start the set (must be called from a user gesture the first time). */
  start(): void {
    if (!this.ready) return;
    const deck = this.decks[this.active];
    if (deck.status === 'paused') return this.resume();
    if (deck.status === 'playing' || deck.status === 'loading') return;
    const resume = this.cb.getResumeItem?.();
    const next = resume?.sourceIds.length ? resume : this.nextItem();
    if (!next) return this.cb.onEmpty();
    this.status = 'starting';
    this.load(deck, next, 'play');
    this.emit();
  }

  /** Called from a tap when the browser blocked autoplay. */
  unblock(): void {
    this.needsGesture = false;
    const deck = this.decks[this.active];
    deck.player?.unMute();
    deck.player?.setVolume(this.master);
    deck.player?.playVideo();
    this.emit();
  }

  pause(): void {
    for (const d of Object.values(this.decks)) {
      if (d.status === 'playing') {
        d.player?.pauseVideo();
        d.status = 'paused';
      }
    }
    if (this.fadeTimer) clearInterval(this.fadeTimer);
    this.status = 'paused';
    this.emit();
  }

  resume(): void {
    const deck = this.decks[this.active];
    if (deck.status !== 'paused') return this.start();
    deck.player?.playVideo();
    if (this.fade) {
      this.decks[this.fade.to].player?.playVideo();
      this.runFade();
    }
    this.status = 'playing';
    this.emit();
  }

  skip(): void {
    const deck = this.decks[this.active];
    if (deck.status !== 'playing' && deck.status !== 'paused') return this.start();
    if (this.fade) return; // already transitioning
    this.beginTransition('skipped', SKIP_FADE_SEC);
  }

  /**
   * Jump within the current hook (host scrub). Clamped to the play window and ignored
   * mid-crossfade, when the active deck is already handing over. Returns the position
   * actually seeked to, or undefined if nothing happened.
   */
  seek(sec: number): number | undefined {
    const deck = this.decks[this.active];
    if (this.fade || !deck.player || !deck.window || (deck.status !== 'playing' && deck.status !== 'paused')) return undefined;
    const to = Math.max(deck.window.startSec, Math.min(deck.window.endSec - 1, sec));
    deck.player.seekTo(to, true);
    this.emit();
    return to;
  }

  setVolume(v: number): void {
    this.master = Math.max(0, Math.min(100, Math.round(v)));
    if (!this.fade) this.decks[this.active].player?.setVolume(this.master);
  }

  destroy(): void {
    this.destroyed = true;
    clearInterval(this.tickTimer);
    clearInterval(this.fadeTimer);
    for (const d of Object.values(this.decks)) {
      clearTimeout(d.loadTimer);
      try {
        d.player?.destroy();
      } catch {
        /* already gone */
      }
    }
  }

  // -------------------------------------------------------------- loading & failover

  private nextItem(excludeId?: string): QueueItemView | undefined {
    const current = this.decks[this.active].item?.track.id;
    return this.cb.getQueue().find((q) => q.track.id !== current && q.track.id !== excludeId && q.sourceIds.length > 0 && !this.triedSongIds.has(q.track.id));
  }

  private load(deck: Deck, item: QueueItemView, purpose: Deck['purpose'], sourceIdx = 0): void {
    const p = deck.player;
    if (!p) return;
    clearTimeout(deck.loadTimer);
    deck.item = item;
    deck.sourceIdx = sourceIdx;
    deck.purpose = purpose;
    deck.status = 'loading';
    deck.window = { ...item.window };
    deck.duration = undefined;
    const videoId = item.sourceIds[sourceIdx]!;
    this.cb.log?.(`Deck ${deck.id}: loading ${item.track.title} [${videoId}] for ${purpose}`);
    if (purpose === 'preroll') p.mute();
    else {
      p.unMute();
      p.setVolume(this.master);
    }
    p.loadVideoById({ videoId, startSeconds: item.window.startSec });
    deck.loadTimer = setTimeout(() => {
      if (deck.status === 'loading') {
        // Still loading after a while: if autoplay was blocked we need a tap, otherwise treat as a dead source.
        const st = p.getPlayerState();
        if (purpose === 'play' && (st === YTState.UNSTARTED || st === YTState.CUED)) {
          this.needsGesture = true;
          this.emit();
        } else this.onError(deck, -1);
      }
    }, LOAD_TIMEOUT_MS);
  }

  private onError(deck: Deck, code: number): void {
    const item = deck.item;
    if (!item) return;
    clearTimeout(deck.loadTimer);
    const sourceId = item.sourceIds[deck.sourceIdx]!;
    this.cb.log?.(`Deck ${deck.id}: ${item.track.title} source ${sourceId} failed (${describeYTError(code)})`);
    this.cb.onSourceFailed(item.track.id, sourceId, code);
    if (deck.sourceIdx + 1 < item.sourceIds.length) {
      this.load(deck, item, deck.purpose, deck.sourceIdx + 1);
      return;
    }
    // No more sources for this song.
    this.triedSongIds.add(item.track.id);
    this.cb.onSongUnplayable(item.track.id);
    deck.status = 'failed';
    deck.item = undefined;
    const isActive = deck.id === this.active && !this.fade;
    if (this.fade && this.fade.to === deck.id) {
      // Incoming failed mid-transition: keep the current song going, retry with another track.
      this.abortFade();
    }
    if (isActive) {
      const next = this.nextItem(item.track.id);
      if (next) this.load(deck, next, 'play');
      else {
        this.status = 'idle';
        this.cb.onEmpty();
      }
    }
    this.emit();
  }

  private onState(deck: Deck, s: number): void {
    if (s === YTState.PLAYING) {
      clearTimeout(deck.loadTimer);
      this.needsGesture = false;
      const p = deck.player!;
      if (deck.status === 'loading') {
        const dur = p.getDuration();
        if (dur > 0) {
          deck.duration = dur;
          deck.window = clampWindow(deck.window!, dur);
        }
        if (deck.purpose === 'preroll') {
          // Buffered and proven playable: park it at the hook start, silent.
          p.pauseVideo();
          p.seekTo(deck.window!.startSec, true);
          deck.status = 'ready';
          this.emit();
          return;
        }
        deck.status = 'playing';
        if (deck.id === this.active && !this.fade) {
          this.status = 'playing';
          this.cb.onStarted(deck.item!, deck.item!.sourceIds[deck.sourceIdx]!, deck.duration);
          this.updateMediaSession(deck.item!);
        }
      } else if (deck.status === 'ready' && this.fade?.to === deck.id) {
        deck.status = 'playing';
      } else if (deck.status === 'paused') {
        deck.status = 'playing';
      }
      if (this.fade?.to === deck.id && !this.fade.started) this.startFadeRamp();
      this.emit();
    } else if (s === YTState.ENDED) {
      if (deck.id === this.active && !this.fade && deck.status === 'playing') this.beginTransition('completed', 1.5);
    }
  }

  // -------------------------------------------------------------- the clock

  private tick(): void {
    const deck = this.decks[this.active];
    if (deck.status !== 'playing' || !deck.player || !deck.window) return;
    const t = deck.player.getCurrentTime();
    const remaining = deck.window.endSec - t;
    const standby = this.decks[other(this.active)];

    // Pre-roll (or re-preroll if the host changed what's next).
    if (!this.fade && remaining <= PRELOAD_LEAD_SEC) {
      const want = this.nextItem();
      if (want && (standby.item?.track.id !== want.track.id || standby.status === 'failed' || standby.status === 'empty')) {
        this.cb.onPreloading(want.track.id);
        this.load(standby, want, 'preroll');
      }
    }
    if (!this.fade && remaining <= this.crossfadeSec) this.beginTransition('completed', this.crossfadeSec);
    this.emit();
  }

  private beginTransition(outcome: Outcome, dur: number): void {
    const from = this.decks[this.active];
    const to = this.decks[other(this.active)];
    const listened = Math.max(0, (from.player?.getCurrentTime() ?? 0) - (from.window?.startSec ?? 0));
    const want = this.nextItem();
    if (!want) {
      if (outcome === 'completed' && from.window && (from.player?.getCurrentTime() ?? 0) < (from.duration ?? Infinity) - 1) return; // let it ride
      this.cb.onEmpty();
      return;
    }
    if (to.item?.track.id !== want.track.id || to.status === 'failed' || to.status === 'empty') {
      this.cb.onPreloading(want.track.id);
      this.load(to, want, 'preroll');
    }
    this.fade = { from: from.id, to: to.id, start: 0, dur, outcome, listened, started: false };
    const p = to.player!;
    if (to.status === 'ready') {
      p.unMute();
      p.setVolume(0);
      p.playVideo();
    } else {
      // Still loading: switch its purpose so it starts audibly (from 0 volume) the moment it plays.
      to.purpose = 'play';
      p.unMute();
      p.setVolume(0);
    }
    this.emit();
  }

  private startFadeRamp(): void {
    const f = this.fade!;
    f.started = true;
    f.start = performance.now();
    const to = this.decks[f.to];
    to.status = 'playing';
    // The new song is audible from here: tell the server now so guests see it immediately.
    const prev = this.decks[f.from].item;
    this.cb.onStarted(to.item!, to.item!.sourceIds[to.sourceIdx]!, to.duration, prev ? { songId: prev.track.id, outcome: f.outcome, listenedSec: Math.round(f.listened) } : undefined);
    this.updateMediaSession(to.item!);
    this.runFade();
  }

  private runFade(): void {
    clearInterval(this.fadeTimer);
    this.fadeTimer = setInterval(() => {
      const f = this.fade;
      if (!f || !f.started) return;
      const prog = Math.min(1, (performance.now() - f.start) / (f.dur * 1000));
      const { out, inn } = equalPower(prog);
      this.decks[f.from].player?.setVolume(Math.round(out * this.master));
      this.decks[f.to].player?.setVolume(Math.round(inn * this.master));
      if (prog >= 1) this.finishFade();
      else this.emit();
    }, 50);
  }

  private finishFade(): void {
    const f = this.fade!;
    clearInterval(this.fadeTimer);
    const from = this.decks[f.from];
    from.player?.stopVideo();
    from.status = 'empty';
    from.item = undefined;
    this.active = f.to;
    this.fade = null;
    this.status = 'playing';
    this.triedSongIds.clear();
    this.emit();
  }

  private abortFade(): void {
    clearInterval(this.fadeTimer);
    if (this.fade) this.decks[this.fade.from].player?.setVolume(this.master);
    this.fade = null;
  }

  // -------------------------------------------------------------- UI state

  snapshot(): EngineState {
    const d = this.decks[this.active];
    const f = this.fade;
    return {
      status: this.status,
      activeDeck: this.active,
      current: d.item,
      sourceId: d.item ? d.item.sourceIds[d.sourceIdx] : undefined,
      position: d.player && (d.status === 'playing' || d.status === 'paused') ? d.player.getCurrentTime() : (d.window?.startSec ?? 0),
      window: d.window,
      duration: d.duration,
      crossfade: f?.started ? Math.min(1, (performance.now() - f.start) / (f.dur * 1000)) : 0,
      incoming: f ? this.decks[f.to].item : undefined,
      needsGesture: this.needsGesture,
      error: this.error,
    };
  }

  private emit(): void {
    this.cb.onChange(this.snapshot());
  }

  private updateMediaSession(item: QueueItemView): void {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: item.track.title,
        artist: item.track.artists.join(', '),
        album: 'Hookline',
        artwork: item.track.artwork ? [{ src: item.track.artwork, sizes: '480x360', type: 'image/jpeg' }] : [],
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => this.skip());
      navigator.mediaSession.setActionHandler('pause', () => this.pause());
      navigator.mediaSession.setActionHandler('play', () => this.resume());
    } catch {
      /* unsupported action */
    }
  }
}

export function equalPower(p: number): { out: number; inn: number } {
  const theta = Math.max(0, Math.min(1, p)) * (Math.PI / 2);
  return { out: Math.cos(theta), inn: Math.sin(theta) };
}

/** Adapt a catalogue hook window to the real upload (some uploads are shorter/longer). */
export function clampWindow(w: { startSec: number; endSec: number }, duration: number): { startSec: number; endSec: number } {
  let { startSec, endSec } = w;
  endSec = Math.min(endSec, duration - 0.5);
  if (startSec > duration - 20) startSec = Math.max(0, duration - 30);
  if (endSec - startSec < 15) endSec = Math.min(duration - 0.5, startSec + 30);
  return { startSec, endSec };
}

const other = (d: 'A' | 'B'): 'A' | 'B' => (d === 'A' ? 'B' : 'A');
