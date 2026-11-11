import type { ArcShape, SetStyle } from './types.ts';

/**
 * Occasions are presets: which catalogue tags fit, what energy journey the
 * night should follow, and how long each song should play by default.
 * They are data, so adding "Diwali" or "Pool party" is a one-object change.
 */
export interface Occasion {
  id: string;
  name: string;
  emoji: string;
  blurb: string;
  /** Tag -> weight (0..1). A song's fit is the max weight of its tags. */
  tagWeights: Record<string, number>;
  arc: ArcShape;
  style: SetStyle;
}

export const OCCASIONS: Occasion[] = [
  {
    id: 'wedding',
    name: 'Wedding Reception',
    emoji: '💍',
    blurb: 'Big crowd-pleasers for every generation, building to a packed floor.',
    tagWeights: { wedding: 1, sangeet: 0.8, baraat: 0.7, mehendi: 0.6, party: 0.5, retro: 0.6 },
    arc: 'build',
    style: 'hooks',
  },
  {
    id: 'baraat',
    name: 'Baraat',
    emoji: '🥁',
    blurb: 'Dhol-heavy, non-stop, street-level energy.',
    tagWeights: { baraat: 1, wedding: 0.6, party: 0.4 },
    arc: 'peak',
    style: 'quick',
  },
  {
    id: 'sangeet',
    name: 'Sangeet',
    emoji: '💃',
    blurb: 'Choreography classics and family favourites.',
    tagWeights: { sangeet: 1, mehendi: 0.7, wedding: 0.7, retro: 0.5, party: 0.4 },
    arc: 'waves',
    style: 'hooks',
  },
  {
    id: 'mehendi',
    name: 'Mehendi & Haldi',
    emoji: '🌼',
    blurb: 'Playful, colourful and sing-along.',
    tagWeights: { mehendi: 1, sangeet: 0.7, wedding: 0.5 },
    arc: 'steady',
    style: 'hooks',
  },
  {
    id: 'house-party',
    name: 'House Party',
    emoji: '🎉',
    blurb: 'Current hits and anthems, riding waves of energy.',
    tagWeights: { party: 1, 'late-night': 0.7, birthday: 0.6, workout: 0.4 },
    arc: 'waves',
    style: 'hooks',
  },
  {
    id: 'birthday',
    name: 'Birthday',
    emoji: '🎂',
    blurb: 'Feel-good bangers everyone knows.',
    tagWeights: { birthday: 1, party: 0.8, retro: 0.4 },
    arc: 'waves',
    style: 'hooks',
  },
  {
    id: 'late-night',
    name: 'Late Night',
    emoji: '🌙',
    blurb: 'Heavy beats for the after-party crowd.',
    tagWeights: { 'late-night': 1, party: 0.7 },
    arc: 'peak',
    style: 'quick',
  },
  {
    id: 'workout',
    name: 'Workout',
    emoji: '🏋️',
    blurb: 'Interval-style pushes with short recoveries.',
    tagWeights: { workout: 1, party: 0.3 },
    arc: 'intervals',
    style: 'quick',
  },
  {
    id: 'road-trip',
    name: 'Road Trip',
    emoji: '🚗',
    blurb: 'Sing-alongs at a steady cruise; full songs, no rush.',
    tagWeights: { retro: 0.8, party: 0.7, sangeet: 0.6, mehendi: 0.5, wedding: 0.4 },
    arc: 'steady',
    style: 'full',
  },
  {
    id: 'festival',
    name: 'Festival',
    emoji: '🪔',
    blurb: 'Ganeshotsav, Navratri & pujas: aartis, gondhal and dhol.',
    tagWeights: { festival: 1, devotional: 0.9, baraat: 0.25 },
    arc: 'build',
    style: 'hooks',
  },
  {
    id: 'retro',
    name: 'Retro Night',
    emoji: '📼',
    blurb: '80s & 90s gold, from Kishore to Kumar Sanu.',
    tagWeights: { retro: 1 },
    arc: 'waves',
    style: 'hooks',
  },
];

export function getOccasion(id: string): Occasion {
  return OCCASIONS.find((o) => o.id === id) ?? OCCASIONS.find((o) => o.id === 'house-party')!;
}

export function occasionFit(occasion: Occasion, tags: string[], extraTags: string[] = []): number {
  let fit = 0;
  for (const t of tags) {
    fit = Math.max(fit, occasion.tagWeights[t] ?? 0);
    if (extraTags.includes(t)) fit = Math.max(fit, 1);
  }
  return fit;
}
