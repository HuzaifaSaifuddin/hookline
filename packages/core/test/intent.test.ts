import { describe, expect, it } from 'vitest';
import { applyIntentPatch, defaultIntent, parseIntentRules, SetIntentSchema } from '../src/intent.ts';
import { Catalog } from '../src/catalog.ts';
import { realSongs } from './fixtures.ts';

const catalog = new Catalog(realSongs());
const artists = [...new Set(realSongs().flatMap((s) => s.artists))];
const parse = (t: string) => parseIntentRules(t, { artists, findSong: (n) => catalog.findByName(n) });

describe('rule-based intent parsing', () => {
  it('understands occasion, language, arc and style', () => {
    const { intent } = parse('Sangeet night, only Punjabi, start slow and build up, full songs please');
    expect(intent.occasion).toBe('sangeet');
    expect(intent.languages).toEqual(['punjabi']);
    expect(intent.arc).toBe('build');
    expect(intent.style).toBe('full');
  });

  it('"mostly" is a soft preference', () => {
    const { intent } = parse('house party, mostly marathi');
    expect(intent.languages).toEqual([]);
    expect(intent.preferLanguages).toEqual(['marathi']);
  });

  it('treats retro next to an occasion as a flavour', () => {
    const { intent } = parse('wedding with lots of 90s classics');
    expect(intent.occasion).toBe('wedding');
    expect(intent.favorTags).toContain('retro');
  });

  it('detects artists to favour and to avoid', () => {
    const { intent } = parse('workout, more Badshah but no Honey Singh');
    expect(intent.occasion).toBe('workout');
    expect(intent.favorArtists.join()).toMatch(/Badshah/);
    expect(intent.avoidArtists.join()).toMatch(/Honey Singh/);
  });

  it('finds a seed song by (misspelled) name', () => {
    const { intent, understood } = parse('birthday party, start with kala chasma');
    expect(intent.seedSongIds).toContain('kala-chashma');
    expect(understood.join()).toMatch(/Kala Chashma/);
  });

  it('defaults sensibly when nothing is recognised', () => {
    const { intent } = parse('surprise me');
    expect(SetIntentSchema.parse(intent).occasion).toBe('house-party');
  });

  it('patches keep arc/style consistent with a new occasion', () => {
    const i = applyIntentPatch(defaultIntent('wedding'), { occasion: 'workout' });
    expect(i.arc).toBe('intervals');
    expect(i.style).toBe('quick');
    expect(applyIntentPatch(i, { energyBias: 9 }).energyBias).toBe(3);
  });
});
