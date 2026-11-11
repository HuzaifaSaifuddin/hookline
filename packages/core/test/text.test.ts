import { describe, expect, it } from 'vitest';
import { searchScore, skeleton, titleMatchScore, TITLE_MISMATCH_THRESHOLD } from '../src/text.ts';

describe('title matching tolerates romanisation', () => {
  it.each([
    ['Chote Chote Peg', 'Chhote Chhote Peg (LYRICAL) | Yo Yo Honey Singh'],
    ['Jedha Nasha', 'Jehda Nasha(Full Video)An Action Hero'],
    ['Dilliwaali Girlfriend', 'Dilliwali Girlfriend Full Song Yeh Jawaani Hai Deewani'],
    ['Kala Chashma', 'Kala Chashma | Baar Baar Dekho | Sidharth M Katrina K'],
    ['Humma Humma (Classic)', 'Humma Humma original song from Bombay| A R Rahman'],
  ])('%s ~ %s', (a, b) => {
    expect(titleMatchScore(a, b)!).toBeGreaterThanOrEqual(0.5);
  });

  it.each([
    ['Chand Chupa Badal Mein', 'Aaj Ki Raat - Full Song | Stree 2'],
    ['Defaulter', 'Refugee'],
    ['Hornn Blow', 'Shubh - Cheques (Official Audio)'],
  ])('%s is NOT %s', (a, b) => {
    expect(titleMatchScore(a, b)!).toBeLessThan(TITLE_MISMATCH_THRESHOLD);
  });

  it('treats jukebox uploads as a mismatch for a single song', () => {
    expect(titleMatchScore('Main Khiladi Tu Anari', 'Main Khiladi Tu Anari Audio Jukebox | Akshay Kumar')).toBe(0);
  });

  it('returns null for non-Latin provider titles', () => {
    expect(titleMatchScore('Dhol Bajne Laga', 'ढोल बजने लगा')).toBeNull();
  });

  it('skeleton folds common spelling variants', () => {
    expect(skeleton('chhote')).toBe(skeleton('chote'));
    expect(skeleton('mehbooba')).toBe(skeleton('mahbooba'));
  });
});

describe('search', () => {
  it('requires every query word to match and prefers title prefix', () => {
    expect(searchScore('kala chashma', 'Kala Chashma', ['Badshah'])).toBeGreaterThan(
      searchScore('kala chashma', 'Chashma Kala Remix', ['x']),
    );
    expect(searchScore('kala banana', 'Kala Chashma', ['Badshah'])).toBe(0);
  });
  it('matches artists and misspellings', () => {
    expect(searchScore('badshah', 'Kala Chashma', ['Badshah'])).toBeGreaterThan(0);
    expect(searchScore('chote peg', 'Chhote Chhote Peg', ['Yo Yo Honey Singh'])).toBeGreaterThan(0);
  });
});
