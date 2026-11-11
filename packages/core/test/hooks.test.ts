import { describe, expect, it } from 'vitest';
import { calibrateHook, defaultHook, resolvePlayWindow, QUICK_MAX_SEC } from '../src/hooks.ts';
import { song } from './fixtures.ts';

describe('play windows', () => {
  const s = song({ id: 'a', durationSec: 300, hook: { startSec: 54, endSec: 142, source: 'seed' } });

  it('hooks mode plays exactly hook_start..hook_end (positions, not durations)', () => {
    expect(resolvePlayWindow(s, 'hooks')).toEqual({ startSec: 54, endSec: 142, basis: 'seed' });
  });
  it('quick mode caps the window', () => {
    const w = resolvePlayWindow(s, 'quick');
    expect(w.startSec).toBe(54);
    expect(w.endSec - w.startSec).toBe(QUICK_MAX_SEC);
  });
  it('full mode plays the whole song', () => {
    expect(resolvePlayWindow(s, 'full')).toEqual({ startSec: 0, endSec: 300, basis: 'full' });
  });
  it('clamps a hook that overruns a shorter upload', () => {
    const w = resolvePlayWindow(s, 'hooks', 120);
    expect(w.endSec).toBe(120);
    expect(w.endSec - w.startSec).toBeGreaterThanOrEqual(20);
  });
  it('derives a default hook when none is authored', () => {
    const w = resolvePlayWindow({ ...s, hook: undefined }, 'hooks', 240);
    expect(w.basis).toBe('default');
    expect(w.startSec).toBe(60);
    expect(w.endSec).toBe(135);
  });
  it('default hook fits very short songs', () => {
    const h = defaultHook(60);
    expect(h.startSec).toBeGreaterThanOrEqual(0);
    expect(h.endSec).toBeLessThanOrEqual(60);
  });
});

describe('crowd hook calibration', () => {
  const hook = { startSec: 50, endSec: 130, source: 'seed' as const };
  it('ignores too few votes', () => {
    expect(calibrateHook(hook, [{ edge: 'start', deltaSec: 10 }, { edge: 'start', deltaSec: 10 }])).toBe(hook);
  });
  it('applies the median nudge, robust to an outlier', () => {
    const h = calibrateHook(hook, [
      { edge: 'start', deltaSec: -5 },
      { edge: 'start', deltaSec: -6 },
      { edge: 'start', deltaSec: 400 },
    ]);
    expect(h).toEqual({ startSec: 45, endSec: 130, source: 'crowd' });
  });
  it('never overrides a curator hook', () => {
    const cur = { ...hook, source: 'curator' as const };
    expect(calibrateHook(cur, Array(5).fill({ edge: 'end', deltaSec: 10 }))).toBe(cur);
  });
});
