import { z } from 'zod';
import { ARCS } from './arc.ts';
import { getOccasion, OCCASIONS } from './occasions.ts';
import { tokens } from './text.ts';
import type { SetIntent, Song } from './types.ts';

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

/** A partial update a host (or the AI) can apply to a running set. */
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

// ---------------------------------------------------------------------------
// Rule-based natural-language understanding (fallback when no LLM is configured)
// ---------------------------------------------------------------------------

const OCCASION_WORDS: Array<[RegExp, string]> = [
  [/\bbaraat\b|\bbarat\b/, 'baraat'],
  [/\bsangeet\b/, 'sangeet'],
  [/\bmeh(e)?ndi\b|\bhaldi\b/, 'mehendi'],
  [/\bwedding\b|\bshaadi\b|\bshadi\b|\breception\b|\bshaddi\b/, 'wedding'],
  [/\bbirthday\b|\bbday\b|\bb'day\b/, 'birthday'],
  [/\blate night\b|\bafter ?party\b|\bdaru\b|\bdrinks\b|\bpregame\b/, 'late-night'],
  [/\bworkout\b|\bgym\b|\brun(ning)?\b|\bcardio\b|\bhiit\b|\blifting\b/, 'workout'],
  [/\broad ?trip\b|\bdrive\b|\bdriving\b|\bcar\b/, 'road-trip'],
  [/\bfestival\b|\bganpati\b|\bganesh\b|\bnavratri\b|\bpuja\b|\bpooja\b|\baarti\b|\bdiwali\b/, 'festival'],
  [/\bretro\b|\b(19)?[789]0s\b|\bold school\b|\bclassics?\b|\bevergreen\b/, 'retro'],
  [/\bparty\b|\bhouse party\b|\bget ?together\b|\bpregame\b/, 'house-party'],
];

const LANGUAGE_WORDS: Array<[RegExp, string]> = [
  [/\bhindi\b|\bbollywood\b/, 'hindi'],
  [/\bpunjabi\b|\bbhangra\b/, 'punjabi'],
  [/\bmarathi\b/, 'marathi'],
  [/\benglish\b|\bwestern\b/, 'english'],
];

const NEGATORS = new Set(['no', 'not', 'without', 'avoid', 'skip', 'except', 'zero', 'less', 'hate', 'never']);

export interface ParseContext {
  /** Distinct artist names in the catalogue. */
  artists: string[];
  findSong: (name: string) => Song | undefined;
  /** Base intent to modify (for "turn it up" mid-set). */
  base?: SetIntent;
}

export interface ParsedIntent {
  intent: SetIntent;
  /** Human-readable list of what was understood, for transparency. */
  understood: string[];
}

export function parseIntentRules(text: string, ctx: ParseContext): ParsedIntent {
  const lower = ` ${text.toLowerCase()} `;
  const understood: string[] = [];

  const occasionHits = OCCASION_WORDS.filter(([re]) => re.test(lower)).map(([, id]) => id);
  // "Retro" next to another occasion is a flavour, not the occasion itself.
  let occasion = occasionHits.find((o) => o !== 'retro') ?? occasionHits[0];
  const intent: SetIntent = ctx.base ? { ...ctx.base } : defaultIntent(occasion ?? 'house-party');
  if (occasion && (!ctx.base || occasion !== ctx.base.occasion)) {
    const d = defaultIntent(occasion, intent.languages);
    Object.assign(intent, { occasion: d.occasion, arc: d.arc, style: d.style });
    understood.push(`Occasion: ${getOccasion(occasion).name}`);
  }
  if (occasionHits.includes('retro') && intent.occasion !== 'retro') {
    intent.favorTags = uniq([...intent.favorTags, 'retro']);
    understood.push('Flavour: retro classics');
  }

  const langs = LANGUAGE_WORDS.filter(([re]) => re.test(lower)).map(([, l]) => l);
  if (langs.length) {
    const only = /\bonly\b|\bjust\b|\bpure\b|\bstrictly\b/.test(lower);
    const mostly = /\bmostly\b|\bmainly\b|\blots of\b|\bmore\b/.test(lower);
    if (mostly && !only) {
      // "Mostly Punjabi" = a soft preference, not a filter.
      intent.preferLanguages = uniq(langs);
      understood.push(`Leaning ${langs.map(cap).join(' + ')}`);
    } else {
      intent.languages = uniq(langs);
      understood.push(`Languages: ${langs.map(cap).join(' + ')}`);
    }
  }

  if (/\bchill\b|\brelax|\bmellow\b|\bcalm\b|\blow[- ]key\b|\bsoft\b|\bdinner\b|\bcocktail\b|\bbackground\b/.test(lower)) {
    intent.energyBias = -2;
    intent.arc = 'steady';
    understood.push('Energy: laid-back');
  } else if (/\bhype\b|\bcrazy\b|\bhigh[- ]energy\b|\bbangers?\b|\blit\b|\bgo hard\b|\bturn (it )?up\b|\bpeak\b|\bmad\b|\bwild\b/.test(lower)) {
    intent.energyBias = Math.min(3, Math.max(intent.energyBias, 0) + 1);
    if (intent.arc === 'steady' || intent.arc === 'build') intent.arc = 'peak';
    understood.push('Energy: high');
  }
  if (/\bslow(ly)? build\b|\bwarm(ing)? up\b|\bstart slow\b|\bbuild (it )?up\b|\bease in\b/.test(lower)) {
    intent.arc = 'build';
    understood.push('Arc: slow build');
  }
  if (/\bcool ?down\b|\bwind(ing)? down\b|\bbring it down\b|\bend of (the )?night\b/.test(lower)) {
    intent.arc = 'cooldown';
    understood.push('Arc: cool down');
  }
  if (/\bfull songs?\b|\bwhole songs?\b|\bcomplete songs?\b|\bentire songs?\b/.test(lower)) {
    intent.style = 'full';
    understood.push('Style: full songs');
  } else if (/\bquick\b|\bshort\b|\bfast[- ]paced\b|\bjust the hooks?\b|\bhooks only\b|\bdrops?\b|\bmashup\b/.test(lower)) {
    intent.style = 'quick';
    understood.push('Style: quick hooks');
  }

  // Artists: find catalogue artists mentioned, decide favour vs avoid by nearby negation.
  const words = tokens(text);
  for (const artist of ctx.artists) {
    const aw = tokens(artist);
    if (aw.length === 0 || (aw.length === 1 && aw[0]!.length < 5)) continue;
    // People drop prefixes: "Yo Yo Honey Singh" -> "Honey Singh".
    let at = indexOfSeq(words, aw);
    if (at < 0 && aw.length >= 3) at = indexOfSeq(words, aw.slice(-2));
    if (at < 0) continue;
    const before = words.slice(Math.max(0, at - 3), at);
    if (before.some((w) => NEGATORS.has(w))) {
      intent.avoidArtists = uniq([...intent.avoidArtists, artist]);
      intent.favorArtists = intent.favorArtists.filter((a) => a !== artist);
      understood.push(`Avoid: ${artist}`);
    } else {
      intent.favorArtists = uniq([...intent.favorArtists, artist]);
      understood.push(`More: ${artist}`);
    }
  }

  // "start with X", "open with X", "play X first"
  const seedMatch = lower.match(/\b(?:start|open|kick ?off|begin)\s+(?:with|it with|off with)\s+([^,.;!]+)/);
  if (seedMatch) {
    const song = ctx.findSong(seedMatch[1]!.replace(/\bfirst\b|\bplease\b/g, '').trim());
    if (song) {
      intent.seedSongIds = uniq([song.id, ...intent.seedSongIds]);
      understood.push(`Opening with: ${song.title}`);
    }
  }

  intent.summary = describeIntent(intent);
  return { intent, understood };
}

function indexOfSeq(hay: string[], needle: string[]): number {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

export const OCCASION_IDS = OCCASIONS.map((o) => o.id);
