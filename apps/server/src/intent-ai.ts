import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import {
  ARCS,
  OCCASIONS,
  applyIntentPatch,
  defaultIntent,
  describeIntent,
  parseIntentRules,
  searchScore,
  type IntentParseResult,
  type SetIntent,
} from '@hookline/core';
import type { CatalogStore } from './catalog-store.ts';

/**
 * Natural-language -> SetIntent.
 *
 * Why an LLM here (and only here): people describe parties in messy, mixed
 * language ("sangeet but the aunties need their 90s fix first, then go full
 * Punjabi, nothing by Honey Singh pls"). Mapping that to a structured plan is
 * a language-understanding problem. Picking songs is not — the deterministic
 * planner does that, so the AI's output is small, validated and bounded.
 *
 * Every failure path (no key, timeout, refusal, bad output) falls back to the
 * rule-based parser, so the product never depends on the LLM being up.
 */

const OccasionIds = OCCASIONS.map((o) => o.id) as [string, ...string[]];
const KNOWN_TAGS = ['wedding', 'baraat', 'sangeet', 'mehendi', 'party', 'birthday', 'late-night', 'workout', 'retro', 'festival', 'devotional'] as const;

const AiIntentSchema = z.object({
  occasion: z.enum(OccasionIds),
  onlyLanguages: z.array(z.string()).describe('Hard filter. Only when the user clearly restricts languages ("only Punjabi").'),
  preferLanguages: z.array(z.string()).describe('Soft preference ("mostly Hindi").'),
  arc: z.enum(['build', 'waves', 'peak', 'intervals', 'steady', 'cooldown']),
  style: z.enum(['quick', 'hooks', 'full']),
  energyBias: z.number().describe('-3 (much calmer) .. +3 (much wilder) relative to the occasion default; 0 if unspecified.'),
  favorTags: z.array(z.enum(KNOWN_TAGS)),
  favorArtists: z.array(z.string()),
  avoidArtists: z.array(z.string()),
  seedSongs: z.array(z.string()).describe('Song titles the user explicitly wants to open with or definitely hear.'),
  djNote: z.string().describe('One short, warm sentence (max ~20 words) the DJ says back to confirm the plan.'),
});
type AiIntent = z.infer<typeof AiIntentSchema>;

export interface IntentParserOptions {
  model: string;
  timeoutMs: number;
  enabled: boolean;
}

export class IntentParser {
  private client: Anthropic | null = null;

  constructor(
    private store: CatalogStore,
    private opts: IntentParserOptions,
    private log: { warn: (o: object, msg: string) => void; info: (o: object, msg: string) => void },
  ) {
    if (opts.enabled) {
      try {
        this.client = new Anthropic({ timeout: opts.timeoutMs, maxRetries: 1 });
      } catch (err) {
        this.log.warn({ err: String(err) }, 'Anthropic client unavailable; using rule-based intent parsing');
      }
    }
  }

  get aiEnabled(): boolean {
    return this.client !== null;
  }

  async parse(text: string, base?: SetIntent): Promise<IntentParseResult> {
    if (this.client) {
      try {
        const started = Date.now();
        const ai = await this.askClaude(text, base);
        if (ai) {
          const result = this.resolve(ai, base);
          this.log.info({ ms: Date.now() - started, engine: 'ai' }, 'intent parsed');
          return result;
        }
      } catch (err) {
        const status = err instanceof Anthropic.APIError ? err.status : undefined;
        this.log.warn({ err: String(err), status }, 'AI intent parsing failed; falling back to rules');
      }
    }
    return this.rules(text, base);
  }

  rules(text: string, base?: SetIntent): IntentParseResult {
    const { intent, understood } = parseIntentRules(text, {
      artists: this.store.artists(),
      findSong: (n) => this.store.catalog.findByName(n),
      base,
    });
    return {
      intent,
      understood,
      engine: 'rules',
      djNote: understood.length ? `Got it: ${intent.summary}.` : `I'll read the room: ${intent.summary}.`,
    };
  }

  private async askClaude(text: string, base?: SetIntent): Promise<AiIntent | null> {
    const languages = this.store.catalog.languages().map((l) => l.language);
    // Stable system prompt (cacheable); volatile data goes in the user turn.
    const system = [
      'You are the music director inside Hookline, an automatic party DJ.',
      'Convert the host\'s description of their event into a structured set plan. Only include what the host actually expressed; use occasion defaults otherwise.',
      '',
      'Occasions:',
      ...OCCASIONS.map((o) => `- ${o.id}: ${o.name}. ${o.blurb} (default arc ${o.arc}, style ${o.style})`),
      '',
      'Arcs:',
      ...ARCS.map((a) => `- ${a.id}: ${a.description}`),
      '',
      'Styles: quick = ~50s of each song\'s hook; hooks = the curated hook section (~60-90s); full = whole songs.',
      'Artists: use the names as the host wrote them; they are matched against the catalogue later.',
      'If the host is modifying an existing plan, keep everything they did not mention unchanged.',
    ].join('\n');
    const user = [
      `Catalogue languages: ${languages.join(', ')}.`,
      base ? `Current plan: ${JSON.stringify(base)}` : 'No plan yet.',
      `Host says: """${text}"""`,
    ].join('\n');

    const response = await this.client!.messages.parse({
      model: this.opts.model,
      max_tokens: 2000,
      output_config: { effort: 'low', format: zodOutputFormat(AiIntentSchema) },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    });
    if (response.stop_reason === 'refusal') {
      this.log.warn({ category: response.stop_details?.category }, 'AI declined intent request');
      return null;
    }
    return response.parsed_output ?? null;
  }

  /** Validate the model's output against the real catalogue. */
  private resolve(ai: AiIntent, base?: SetIntent): IntentParseResult {
    const langs = new Set(this.store.catalog.languages().map((l) => l.language));
    const artists = this.store.artists();
    const matchArtist = (name: string): string | undefined => {
      let best: [number, string] | undefined;
      for (const a of artists) {
        const s = searchScore(name, a, []);
        if (s > 0 && (!best || s > best[0])) best = [s, a];
      }
      return best?.[1];
    };
    const understood: string[] = [];
    const seedSongIds: string[] = [];
    for (const title of ai.seedSongs.slice(0, 5)) {
      const song = this.store.catalog.findByName(title);
      if (song) {
        seedSongIds.push(song.id);
        understood.push(`Will play: ${song.title}`);
      } else understood.push(`Couldn't find "${title}" in the catalogue`);
    }
    const favorArtists = uniq(ai.favorArtists.map(matchArtist).filter((a): a is string => !!a));
    const avoidArtists = uniq(ai.avoidArtists.map(matchArtist).filter((a): a is string => !!a));

    const start = base ?? defaultIntent(ai.occasion);
    const intent = applyIntentPatch(start, {
      occasion: ai.occasion,
      languages: ai.onlyLanguages.map((l) => l.toLowerCase()).filter((l) => langs.has(l)),
      preferLanguages: ai.preferLanguages.map((l) => l.toLowerCase()).filter((l) => langs.has(l)),
      arc: ai.arc,
      style: ai.style,
      energyBias: Math.round(Math.max(-3, Math.min(3, ai.energyBias))),
      favorTags: [...ai.favorTags],
      favorArtists,
      avoidArtists,
      seedSongIds,
    });
    intent.summary = describeIntent(intent);
    if (favorArtists.length) understood.push(`More: ${favorArtists.join(', ')}`);
    if (avoidArtists.length) understood.push(`Avoid: ${avoidArtists.join(', ')}`);
    return { intent, understood, engine: 'ai', djNote: ai.djNote.slice(0, 200) };
  }
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];
