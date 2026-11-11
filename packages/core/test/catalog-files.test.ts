import { describe, expect, it } from 'vitest';
import { CatalogEntrySchema, isAutoPlayable } from '../src/catalog.ts';
import { readEntries, realSongs } from './fixtures.ts';

describe('catalogue files (catalog/songs/*.json)', () => {
  const entries = readEntries();

  it('every entry matches the schema', () => {
    const errors: string[] = [];
    for (const e of entries) {
      const r = CatalogEntrySchema.safeParse(e);
      if (!r.success) errors.push(`${(e as { id?: string }).id}: ${r.error.issues.map((i) => i.message).join('; ')}`);
    }
    expect(errors).toEqual([]);
  });

  it('ids are unique across language files', () => {
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('hooks are inside the song and long enough to enjoy', () => {
    for (const e of entries) {
      if (!e.hook) continue;
      expect(e.hook.endSec - e.hook.startSec, e.id).toBeGreaterThanOrEqual(20);
      if (e.durationSec) expect(e.hook.endSec, e.id).toBeLessThanOrEqual(e.durationSec);
    }
  });

  it('the vast majority of songs are auto-playable after verification', () => {
    const songs = realSongs();
    const playable = songs.filter(isAutoPlayable).length;
    expect(playable / songs.length).toBeGreaterThan(0.9);
  });
});
