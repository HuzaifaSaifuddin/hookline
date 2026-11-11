import { z } from 'zod';
import { ARCS } from './arc.ts';
import { getOccasion } from './occasions.ts';
import type { SetIntent } from './types.ts';

export const SetIntentSchema = z.object({
  occasion: z.string(),
  languages: z.array(z.string()).default([]),
  preferLanguages: z.array(z.string()).default([]),
  arc: z.enum(['build', 'waves', 'peak', 'intervals', 'steady', 'cooldown']),
  style: z.enum(['quick', 'hooks', 'full']),
  energyBias: z.number().min(-3).max(3).default(0),
  favorTags: z.array(z.string()).default([]),
  favorArtists: z.array(z.string()).default([]),
  avoidArtists: z.array(z.string()).default([]),
  seedSongIds: z.array(z.string()).default([]),
  summary: z.string().optional(),
});

/** A partial update the host can apply to a running set. */
export const IntentPatchSchema = SetIntentSchema.partial();
export type IntentPatch = z.infer<typeof IntentPatchSchema>;

export function defaultIntent(occasionId: string, languages: string[] = []): SetIntent {
  const o = getOccasion(occasionId);
  return {
    occasion: o.id,
    languages,
    preferLanguages: [],
    arc: o.arc,
    style: o.style,
    energyBias: 0,
    favorTags: [],
    favorArtists: [],
    avoidArtists: [],
    seedSongIds: [],
  };
}

export function applyIntentPatch(intent: SetIntent, patch: IntentPatch): SetIntent {
  const next: SetIntent = { ...intent };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
  if (patch.occasion && patch.occasion !== intent.occasion) {
    const o = getOccasion(patch.occasion);
    next.occasion = o.id;
    if (!patch.arc) next.arc = o.arc;
    if (!patch.style) next.style = o.style;
  }
  next.energyBias = Math.max(-3, Math.min(3, next.energyBias));
  return next;
}

export function describeIntent(intent: SetIntent): string {
  const o = getOccasion(intent.occasion);
  const arc = ARCS.find((a) => a.id === intent.arc)?.name ?? intent.arc;
  const style = { quick: 'quick hooks', hooks: 'hooks', full: 'full songs' }[intent.style];
  const langs = intent.languages.length
    ? intent.languages.map(cap).join(' + ')
    : intent.preferLanguages.length
      ? `mostly ${intent.preferLanguages.map(cap).join(' + ')}`
      : 'all languages';
  const bits = [`${o.name}`, langs, `${arc.toLowerCase()} arc`, style];
  if (intent.energyBias > 0) bits.push(`energy +${intent.energyBias}`);
  if (intent.energyBias < 0) bits.push(`energy ${intent.energyBias}`);
  if (intent.favorTags.length) bits.push(`extra ${intent.favorTags.join(', ')}`);
  if (intent.favorArtists.length) bits.push(`more ${intent.favorArtists.join(', ')}`);
  if (intent.avoidArtists.length) bits.push(`no ${intent.avoidArtists.join(', ')}`);
  return bits.join(' · ');
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
