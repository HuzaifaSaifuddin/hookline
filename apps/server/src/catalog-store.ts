import fs from 'node:fs';
import path from 'node:path';
import {
  Catalog,
  CatalogEntrySchema,
  calibrateHook,
  entryToSong,
  type CatalogEntry,
  type HookNudge,
  type Song,
  type SongStats,
  type VerificationRecord,
} from '@hookline/core';
import type { DB } from './db.ts';

/** A source that fails this many times (with no successes since) is demoted. */
const FAILURES_TO_DEMOTE = 2;
/** Skipped within this many seconds = an "early skip" (a negative signal). */
export const EARLY_SKIP_SEC = 15;

export interface CatalogLoadReport {
  files: number;
  songs: number;
  invalid: string[];
  custom: number;
  quarantined: number;
}

/**
 * The live catalogue: git-tracked entries + runtime learning from the DB.
 * Everything is held in memory (~1k songs); writes go to SQLite synchronously
 * (node:sqlite is synchronous and these writes are tiny and infrequent).
 */
export class CatalogStore {
  readonly catalog = new Catalog();
  private entries = new Map<string, CatalogEntry>();
  private verification: Record<string, VerificationRecord> = {};
  private stats = new Map<string, SongStats>();
  private nudges = new Map<string, HookNudge[]>();
  report!: CatalogLoadReport;

  constructor(
    private db: DB,
    private catalogDir: string,
  ) {}

  load(): CatalogLoadReport {
    const songsDir = path.join(this.catalogDir, 'songs');
    const verFile = path.join(this.catalogDir, 'verification', 'youtube.json');
    this.verification = fs.existsSync(verFile) ? JSON.parse(fs.readFileSync(verFile, 'utf8')) : {};
    const invalid: string[] = [];
    const files = fs.readdirSync(songsDir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const raw = JSON.parse(fs.readFileSync(path.join(songsDir, f), 'utf8')) as unknown[];
      for (const r of raw) {
        const parsed = CatalogEntrySchema.safeParse(r);
        if (parsed.success) this.entries.set(parsed.data.id, parsed.data);
        else invalid.push(`${f}: ${(r as { id?: string }).id ?? '?'} — ${parsed.error.issues[0]?.message}`);
      }
    }
    let custom = 0;
    for (const row of this.db.prepare('SELECT entry FROM custom_songs').all() as Array<{ entry: string }>) {
      const parsed = CatalogEntrySchema.safeParse(JSON.parse(row.entry));
      if (parsed.success && !this.entries.has(parsed.data.id)) {
        this.entries.set(parsed.data.id, parsed.data);
        custom++;
      }
    }
    for (const n of this.db.prepare('SELECT song_id, edge, delta_sec FROM hook_nudges').all() as Array<{
      song_id: string;
      edge: 'start' | 'end';
      delta_sec: number;
    }>) {
      const list = this.nudges.get(n.song_id) ?? [];
      list.push({ edge: n.edge, deltaSec: n.delta_sec });
      this.nudges.set(n.song_id, list);
    }
    this.loadStats();
    for (const id of this.entries.keys()) this.rebuild(id);
    const quarantined = this.catalog.all().filter((s) => s.review).length;
    this.report = { files: files.length, songs: this.catalog.size, invalid, custom, quarantined };
    return this.report;
  }

  /** Recompute the live Song from its entry + all DB overlays. */
  private rebuild(id: string): Song | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const flags = this.db.prepare('SELECT verified, duration_sec FROM song_flags WHERE song_id = ?').get(id) as
      | { verified: number; duration_sec: number | null }
      | undefined;
    const song = entryToSong({ ...entry, verified: entry.verified || !!flags?.verified }, this.verification);
    if (!song.durationSec && flags?.duration_sec) song.durationSec = Math.round(flags.duration_sec);

    const override = this.db.prepare('SELECT start_sec, end_sec FROM hook_overrides WHERE song_id = ?').get(id) as
      | { start_sec: number; end_sec: number }
      | undefined;
    if (override) song.hook = { startSec: override.start_sec, endSec: override.end_sec, source: 'curator' };
    else if (song.hook) song.hook = calibrateHook(song.hook, this.nudges.get(id) ?? [], song.durationSec);

    // Runtime source health: demote sources that keep failing in real players.
    const health = this.db
      .prepare('SELECT source_id, failures, successes, last_code FROM source_health WHERE song_id = ?')
      .all(id) as Array<{ source_id: string; failures: number; successes: number; last_code: number | null }>;
    for (const h of health) {
      const src = song.sources.find((s) => s.id === h.source_id);
      if (!src) continue;
      if (h.last_code === 100) src.status = 'unavailable';
      else if (h.last_code === 101 || h.last_code === 150) src.status = 'unembeddable';
      else if (h.failures >= FAILURES_TO_DEMOTE && h.successes === 0) src.status = 'failing';
    }
    if (song.sources.every((s) => s.status !== 'ok' && s.status !== 'unverified')) song.review = 'no-playable-source';

    this.catalog.upsert(song);
    return song;
  }

  private loadStats(): void {
    const rows = this.db
      .prepare(
        `SELECT song_id,
                COUNT(*) AS plays,
                SUM(outcome = 'completed') AS completions,
                SUM(outcome = 'skipped' AND listened_sec < ?) AS early_skips,
                MAX(started_at) AS last_played
           FROM play_events GROUP BY song_id`,
      )
      .all(EARLY_SKIP_SEC) as Array<{ song_id: string; plays: number; completions: number; early_skips: number; last_played: number }>;
    for (const r of rows) {
      this.stats.set(r.song_id, {
        plays: r.plays,
        completions: r.completions ?? 0,
        earlySkips: r.early_skips ?? 0,
        likes: 0,
        dislikes: 0,
        lastPlayedAt: r.last_played,
      });
    }
    const fb = this.db.prepare('SELECT song_id, kind, COUNT(*) AS n FROM feedback GROUP BY song_id, kind').all() as Array<{
      song_id: string;
      kind: string;
      n: number;
    }>;
    for (const r of fb) {
      const s = this.statsFor(r.song_id);
      if (r.kind === 'like' || r.kind === 'love') s.likes += r.n;
      if (r.kind === 'dislike' || r.kind === 'meh') s.dislikes += r.n;
    }
  }

  private statsFor(id: string): SongStats {
    let s = this.stats.get(id);
    if (!s) this.stats.set(id, (s = { plays: 0, completions: 0, earlySkips: 0, likes: 0, dislikes: 0 }));
    return s;
  }

  getStats = (id: string): SongStats | undefined => this.stats.get(id);

  // ---- runtime learning -------------------------------------------------

  recordPlayStart(room: string, songId: string, sourceId: string, occasion: string, now = Date.now()): number {
    const r = this.db
      .prepare('INSERT INTO play_events (room, song_id, source_id, started_at, occasion) VALUES (?,?,?,?,?)')
      .run(room, songId, sourceId, now, occasion);
    const s = this.statsFor(songId);
    s.plays++;
    s.lastPlayedAt = now;
    // A source that started playing is healthy.
    this.db
      .prepare(
        `INSERT INTO source_health (source_id, song_id, successes) VALUES (?, ?, 1)
         ON CONFLICT(source_id) DO UPDATE SET successes = successes + 1`,
      )
      .run(sourceId, songId);
    return Number(r.lastInsertRowid);
  }

  recordPlayEnd(eventId: number, songId: string, outcome: 'completed' | 'skipped' | 'error', listenedSec: number): void {
    this.db.prepare('UPDATE play_events SET outcome = ?, listened_sec = ? WHERE id = ?').run(outcome, listenedSec, eventId);
    const s = this.statsFor(songId);
    if (outcome === 'completed') s.completions++;
    if (outcome === 'skipped' && listenedSec < EARLY_SKIP_SEC) s.earlySkips++;
  }

  recordFeedback(room: string, songId: string, kind: 'like' | 'dislike' | 'love' | 'meh', who?: string): void {
    this.db
      .prepare('INSERT INTO feedback (room, song_id, kind, who, created_at) VALUES (?,?,?,?,?)')
      .run(room, songId, kind, who ?? null, Date.now());
    const s = this.statsFor(songId);
    if (kind === 'like' || kind === 'love') s.likes++;
    else s.dislikes++;
  }

  recordSourceFailure(songId: string, sourceId: string, code: number): Song | undefined {
    this.db
      .prepare(
        `INSERT INTO source_health (source_id, song_id, failures, last_code, last_failed_at) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET failures = failures + 1, last_code = excluded.last_code,
           last_failed_at = excluded.last_failed_at`,
      )
      .run(sourceId, songId, code, Date.now());
    return this.rebuild(songId);
  }

  recordDuration(songId: string, durationSec: number): void {
    const song = this.catalog.get(songId);
    if (!song || song.durationSec) return;
    this.db
      .prepare(
        `INSERT INTO song_flags (song_id, duration_sec, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(song_id) DO UPDATE SET duration_sec = excluded.duration_sec, updated_at = excluded.updated_at`,
      )
      .run(songId, durationSec, Date.now());
    this.rebuild(songId);
  }

  addHookNudge(songId: string, nudge: HookNudge, room?: string): Song | undefined {
    this.db
      .prepare('INSERT INTO hook_nudges (song_id, edge, delta_sec, room, created_at) VALUES (?,?,?,?,?)')
      .run(songId, nudge.edge, nudge.deltaSec, room ?? null, Date.now());
    const list = this.nudges.get(songId) ?? [];
    list.push(nudge);
    this.nudges.set(songId, list);
    return this.rebuild(songId);
  }

  setCuratorHook(songId: string, startSec: number, endSec: number): Song | undefined {
    if (!this.entries.has(songId)) return undefined;
    this.db
      .prepare(
        `INSERT INTO hook_overrides (song_id, start_sec, end_sec, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(song_id) DO UPDATE SET start_sec = excluded.start_sec, end_sec = excluded.end_sec, updated_at = excluded.updated_at`,
      )
      .run(songId, startSec, endSec, Date.now());
    return this.rebuild(songId);
  }

  clearCuratorHook(songId: string): Song | undefined {
    this.db.prepare('DELETE FROM hook_overrides WHERE song_id = ?').run(songId);
    return this.rebuild(songId);
  }

  markVerified(songId: string): Song | undefined {
    if (!this.entries.has(songId)) return undefined;
    this.db
      .prepare(
        `INSERT INTO song_flags (song_id, verified, updated_at) VALUES (?, 1, ?)
         ON CONFLICT(song_id) DO UPDATE SET verified = 1, updated_at = excluded.updated_at`,
      )
      .run(songId, Date.now());
    return this.rebuild(songId);
  }

  addCustomSong(entry: CatalogEntry, providerTitle?: string): Song {
    const parsed = CatalogEntrySchema.parse(entry);
    this.db
      .prepare('INSERT OR REPLACE INTO custom_songs (id, entry, created_at) VALUES (?,?,?)')
      .run(parsed.id, JSON.stringify(parsed), Date.now());
    this.entries.set(parsed.id, parsed);
    if (providerTitle) {
      for (const s of parsed.sources) {
        this.verification[s.id] ??= { status: 'ok', title: providerTitle, checkedAt: new Date().toISOString() };
      }
    }
    return this.rebuild(parsed.id)!;
  }

  hasId(id: string): boolean {
    return this.entries.has(id);
  }

  findBySourceId(sourceId: string): Song | undefined {
    return this.catalog.all().find((s) => s.sources.some((x) => x.id === sourceId));
  }

  artists(): string[] {
    return [...new Set(this.catalog.all().flatMap((s) => s.artists))];
  }

  nudgeCount(songId: string): number {
    return this.nudges.get(songId)?.length ?? 0;
  }
}
