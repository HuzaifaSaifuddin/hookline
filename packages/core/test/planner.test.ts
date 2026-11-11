import { describe, expect, it } from 'vitest';
import { defaultIntent } from '../src/intent.ts';
import { planQueue, pickNext, seededRng, type PlannerContext } from '../src/planner.ts';
import { emptyTaste, type SetIntent } from '../src/types.ts';
import { realSongs, song } from './fixtures.ts';

const NOW = Date.parse('2026-11-11T20:00:00Z');

function ctx(intent: Partial<SetIntent> = {}, extra: Partial<PlannerContext> = {}): PlannerContext {
  return {
    songs: realSongs(),
    intent: { ...defaultIntent('wedding'), ...intent },
    history: [],
    elapsedSec: 0,
    taste: emptyTaste(),
    requests: [],
    now: NOW,
    rng: seededRng(42),
    ...extra,
  };
}

describe('planner on the real catalogue', () => {
  const plan = planQueue(ctx(), 60);

  it('plans a long set with no repeats', () => {
    expect(plan).toHaveLength(60);
    expect(new Set(plan.map((p) => p.song.id)).size).toBe(60);
  });

  it('never plays the same artist back-to-back', () => {
    for (let i = 1; i < plan.length; i++) {
      const prev = plan[i - 1]!.song.artists.map((a) => a.toLowerCase());
      const shared = plan[i]!.song.artists.some((a) => prev.includes(a.toLowerCase()));
      expect(shared, `${plan[i - 1]!.song.title} -> ${plan[i]!.song.title}`).toBe(false);
    }
  });

  it('follows the build arc: the opening is calmer than the peak', () => {
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const opening = avg(plan.slice(0, 6).map((p) => p.song.energy));
    const later = avg(plan.slice(30, 45).map((p) => p.song.energy));
    expect(later).toBeGreaterThan(opening);
  });

  it('every pick explains itself', () => {
    for (const p of plan) expect(p.reasons.length).toBeGreaterThan(0);
  });

  it('never auto-plays medleys or devotional tracks at a wedding', () => {
    for (const p of plan) {
      expect(p.song.tags).not.toContain('medley');
      expect(p.song.tags).not.toContain('devotional');
    }
  });

  it('a festival set draws on devotional/festival music', () => {
    const p = planQueue(ctx({ occasion: 'festival', arc: 'build' }), 10);
    expect(p.filter((x) => x.song.tags.includes('festival')).length).toBeGreaterThanOrEqual(8);
  });

  it('only picks auto-playable songs that fit the occasion', () => {
    for (const p of plan) {
      expect(p.song.review).toBeUndefined();
      expect(p.song.tags.some((t) => ['wedding', 'sangeet', 'baraat', 'mehendi', 'party', 'retro'].includes(t))).toBe(true);
    }
  });

  it('is deterministic for a given seed', () => {
    const again = planQueue(ctx(), 10).map((p) => p.song.id);
    expect(again).toEqual(plan.slice(0, 10).map((p) => p.song.id));
  });

  it('respects a hard language filter', () => {
    const p = planQueue(ctx({ languages: ['punjabi'] }), 15);
    expect(p.every((x) => x.song.language === 'punjabi')).toBe(true);
  });

  it('soft-prefers languages without excluding others entirely', () => {
    const p = planQueue(ctx({ occasion: 'house-party', preferLanguages: ['marathi'] }), 30);
    const marathi = p.filter((x) => x.song.language === 'marathi').length;
    expect(marathi).toBeGreaterThan(15); // a majority, not a monopoly
    expect(marathi).toBeLessThan(30);
  });

  it('never plays avoided artists', () => {
    const p = planQueue(ctx({ occasion: 'house-party', avoidArtists: ['Badshah', 'Honey Singh'] }), 40);
    for (const x of p) expect(x.song.artists.join(' ')).not.toMatch(/badshah|honey singh/i);
  });

  it('opens with a seed song', () => {
    const target = realSongs().find((s) => s.id === 'kala-chashma')!;
    expect(pickNext(ctx({ seedSongIds: [target.id] }))!.song.id).toBe(target.id);
  });

  it('plays a guest request promptly, even outside the language filter', () => {
    const req = realSongs().find((s) => s.language === 'english' && !s.review)!;
    const p = planQueue(
      ctx({ languages: ['hindi'] }, { requests: [{ id: 'r1', songId: req.id, requestedBy: 'Sara', voters: [], createdAt: NOW }] }),
      3,
    );
    const hit = p.find((x) => x.song.id === req.id);
    expect(hit).toBeDefined();
    expect(hit!.requestId).toBe('r1');
    expect(hit!.reasons[0]).toMatch(/Requested by Sara/);
  });

  it('banned songs and long-term skips steer the plan', () => {
    const first = pickNext(ctx())!;
    const second = pickNext(ctx({}, { taste: { ...emptyTaste(), bannedSongIds: [first.song.id] } }))!;
    expect(second.song.id).not.toBe(first.song.id);
  });

  it('raising the energy bias raises the energy of picks', () => {
    const avg = (b: number) => {
      const p = planQueue(ctx({ occasion: 'road-trip', arc: 'steady', energyBias: b }), 15);
      return p.reduce((a, x) => a + x.song.energy, 0) / p.length;
    };
    expect(avg(2)).toBeGreaterThan(avg(-2));
  });
});

describe('planner edge cases', () => {
  it('relaxes constraints instead of going silent when the pool runs dry', () => {
    const songs = [song({ id: 'a', tags: ['workout'] }), song({ id: 'b', tags: ['workout'] })];
    const c = ctx({ occasion: 'sangeet' }, { songs });
    const p = planQueue(c, 5);
    expect(p.length).toBe(5); // repeats allowed as a last resort
  });

  it('returns null when nothing is playable', () => {
    const songs = [song({ id: 'a', sources: [{ provider: 'youtube', id: 'y'.repeat(11), status: 'unavailable', titleMatch: 1 }] })];
    expect(pickNext(ctx({}, { songs }))).toBeNull();
  });
});
