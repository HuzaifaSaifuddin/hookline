import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * SQLite via Node's built-in `node:sqlite` (no native addon to compile).
 *
 * The canonical catalogue lives in git (catalog/songs/*.json). The database
 * stores only what is *learned at runtime*: curator hook edits, crowd hook
 * nudges, source health, user-added songs, play events, feedback and rooms.
 * `npm run catalog:export` folds curated data back into the catalogue files.
 */

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE custom_songs (
    id TEXT PRIMARY KEY,
    entry TEXT NOT NULL,            -- CatalogEntry JSON
    created_at INTEGER NOT NULL
  );
  CREATE TABLE hook_overrides (
    song_id TEXT PRIMARY KEY,
    start_sec REAL NOT NULL,
    end_sec REAL NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE hook_nudges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id TEXT NOT NULL,
    edge TEXT NOT NULL CHECK (edge IN ('start','end')),
    delta_sec REAL NOT NULL,
    room TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX hook_nudges_song ON hook_nudges(song_id);
  CREATE TABLE source_health (
    source_id TEXT PRIMARY KEY,
    song_id TEXT NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    last_code INTEGER,
    last_failed_at INTEGER,
    successes INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE song_flags (
    song_id TEXT PRIMARY KEY,
    verified INTEGER NOT NULL DEFAULT 0,
    duration_sec REAL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE play_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    song_id TEXT NOT NULL,
    source_id TEXT,
    started_at INTEGER NOT NULL,
    outcome TEXT,
    listened_sec REAL,
    occasion TEXT
  );
  CREATE INDEX play_events_song ON play_events(song_id);
  CREATE TABLE feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    song_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    who TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX feedback_song ON feedback(song_id);
  CREATE TABLE rooms (
    code TEXT PRIMARY KEY,
    host_key TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v2: a player error is only a *report*. Whether an upload is really blocked or gone is
  // confirmed server-side (oEmbed) before it is demoted for everyone — see CatalogStore.
  `
  ALTER TABLE source_health ADD COLUMN confirmed_status TEXT;
  ALTER TABLE source_health ADD COLUMN confirmed_at INTEGER;
  `,
];

export type DB = DatabaseSync;

export function openDatabase(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]!);
      version++;
      db.prepare('UPDATE schema_version SET version = ?').run(version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}
