import type { Hook, SetStyle, Song } from './types.ts';

/**
 * Hook-based playback.
 *
 * `hook.startSec` / `hook.endSec` are positions in the original recording
 * (not a duration). The DJ seeks to startSec, plays until endSec, and starts
 * the crossfade so the next song's hook lands as this one ends.
 */

export interface PlayWindow {
  startSec: number;
  endSec: number;
  /** Where the timings came from — shown in the UI and used to prioritise curation. */
  basis: Hook['source'] | 'full';
}

/** Used when a song has no authored hook (e.g. user-added songs). */
export const DEFAULT_HOOK_LENGTH_SEC = 75;
/** In "quick" style we cap each song so the set moves fast. */
export const QUICK_MAX_SEC = 50;
/** Never play a window shorter than this — a crossfade needs room to breathe. */
export const MIN_WINDOW_SEC = 20;

/**
 * Default hook for a song we know nothing about. Most pop songs reach their
 * first chorus around 25–35% in; we start slightly before that.
 */
export function defaultHook(durationSec: number): Hook {
  const start = Math.round(Math.min(Math.max(durationSec * 0.25, 20), Math.max(0, durationSec - DEFAULT_HOOK_LENGTH_SEC)));
  const end = Math.min(durationSec, start + DEFAULT_HOOK_LENGTH_SEC);
  return { startSec: start, endSec: end, source: 'default' };
}

/**
 * The window the DJ will actually play.
 * @param actualDurationSec duration reported by the player at runtime; wins over catalogue data
 *        (uploads differ: a "lyrical" upload may be 10s longer than the one the catalogue timed).
 */
export function resolvePlayWindow(song: Song, style: SetStyle, actualDurationSec?: number): PlayWindow {
  const duration = actualDurationSec && actualDurationSec > 0 ? actualDurationSec : song.durationSec;

  if (style === 'full') {
    return { startSec: 0, endSec: duration ?? song.hook?.endSec ?? DEFAULT_HOOK_LENGTH_SEC, basis: 'full' };
  }

  let hook: Hook | undefined = song.hook;
  if (!hook) hook = duration ? defaultHook(duration) : { startSec: 30, endSec: 30 + DEFAULT_HOOK_LENGTH_SEC, source: 'default' };

  let { startSec, endSec } = hook;
  if (duration) {
    // A hook authored against a different upload may overrun this video; clamp it.
    endSec = Math.min(endSec, duration);
    if (startSec > duration - MIN_WINDOW_SEC) startSec = Math.max(0, duration - MIN_WINDOW_SEC);
  }
  if (endSec - startSec < MIN_WINDOW_SEC) endSec = startSec + MIN_WINDOW_SEC;
  if (style === 'quick') endSec = Math.min(endSec, startSec + QUICK_MAX_SEC);

  return { startSec, endSec, basis: hook.source };
}

export function hookLength(w: { startSec: number; endSec: number }): number {
  return w.endSec - w.startSec;
}

/**
 * Crowd calibration: listeners can say "the drop came late" / "cut too early".
 * Each vote is a signed nudge in seconds for one edge of the hook. Once enough
 * votes agree we shift the edge by their median (robust to trolls), bounded so
 * the crowd can refine but not wreck a hook.
 */
export interface HookNudge {
  edge: 'start' | 'end';
  deltaSec: number;
}

export const MIN_NUDGES_TO_APPLY = 3;
export const MAX_CROWD_SHIFT_SEC = 20;

export function calibrateHook(hook: Hook, nudges: HookNudge[], durationSec?: number): Hook {
  if (hook.source === 'curator') return hook; // explicit human decision wins
  const shift = (edge: HookNudge['edge']): number => {
    const d = nudges.filter((n) => n.edge === edge).map((n) => n.deltaSec);
    if (d.length < MIN_NUDGES_TO_APPLY) return 0;
    return Math.max(-MAX_CROWD_SHIFT_SEC, Math.min(MAX_CROWD_SHIFT_SEC, median(d)));
  };
  const ds = shift('start');
  const de = shift('end');
  if (ds === 0 && de === 0) return hook;
  let startSec = Math.max(0, hook.startSec + ds);
  let endSec = hook.endSec + de;
  if (durationSec) endSec = Math.min(endSec, durationSec);
  if (endSec - startSec < MIN_WINDOW_SEC) {
    startSec = hook.startSec;
    endSec = hook.endSec;
  }
  return { startSec, endSec, source: 'crowd' };
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
