import fs from 'node:fs';
import path from 'node:path';
import { CatalogEntrySchema, entryToSong, type CatalogEntry, type VerificationRecord } from '../src/catalog.ts';
import type { Song } from '../src/types.ts';

export const CATALOG_DIR = path.resolve(import.meta.dirname, '../../../catalog');

export function readEntries(): CatalogEntry[] {
  const dir = path.join(CATALOG_DIR, 'songs');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

export function readVerification(): Record<string, VerificationRecord> {
  const f = path.join(CATALOG_DIR, 'verification', 'youtube.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}

let cached: Song[] | undefined;
export function realSongs(): Song[] {
  const v = readVerification();
  return (cached ??= readEntries().map((e) => entryToSong(CatalogEntrySchema.parse(e), v)));
}

export function song(partial: Partial<Song> & { id: string }): Song {
  return {
    title: partial.id,
    artists: ['Artist ' + partial.id],
    language: 'hindi',
    energy: 8,
    popularity: 0.3,
    tags: ['party'],
    sources: [{ provider: 'youtube', id: 'x'.repeat(11), status: 'ok', titleMatch: 1 }],
    origin: 'test',
    durationSec: 200,
    hook: { startSec: 40, endSec: 110, source: 'seed' },
    ...partial,
  };
}
