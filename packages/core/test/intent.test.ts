import { describe, expect, it } from 'vitest';
import { applyIntentPatch, defaultIntent, describeIntent, SetIntentSchema } from '../src/intent.ts';

describe('set intent', () => {
  it('defaults come from the occasion', () => {
    const i = defaultIntent('workout', ['punjabi']);
    expect(i).toMatchObject({ occasion: 'workout', arc: 'intervals', style: 'quick', languages: ['punjabi'] });
    expect(SetIntentSchema.parse(i).occasion).toBe('workout');
  });

  it('unknown occasions fall back to a house party', () => {
    expect(defaultIntent('nope').occasion).toBe('house-party');
  });

  it('patches keep arc/style consistent with a new occasion and clamp energy', () => {
    const i = applyIntentPatch(defaultIntent('wedding'), { occasion: 'workout' });
    expect(i.arc).toBe('intervals');
    expect(i.style).toBe('quick');
    expect(applyIntentPatch(i, { energyBias: 9 }).energyBias).toBe(3);
  });

  it('describes the plan in words', () => {
    const i = applyIntentPatch(defaultIntent('sangeet', ['punjabi']), { energyBias: 1 });
    expect(describeIntent(i)).toBe('Sangeet · Punjabi · waves arc · hooks · energy +1');
  });
});
