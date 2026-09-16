import type { Database } from 'better-sqlite3';
import { createLogger } from '../util/logger.ts';

const log = createLogger('db');

/**
 * Clips used to be destroyed along with their recording. They are exported work
 * and worth keeping, so the foreign key became ON DELETE SET NULL — which
 * SQLite cannot change in place, hence the table rebuild.
 */
function detachClipsFromRecordings(db: Database): void {
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'clips'").get() as
    | { sql: string }
    | undefined;
  if (!existing || !existing.sql.includes('ON DELETE CASCADE')) return;

  log.info('migrating clips so they survive their recording');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    BEGIN;
    CREATE TABLE clips_migrated (
      id            TEXT PRIMARY KEY,
      recording_id  TEXT REFERENCES recordings(id) ON DELETE SET NULL,
      source_title  TEXT,
      title         TEXT NOT NULL,
      start_sec     REAL NOT NULL,
      end_sec       REAL NOT NULL,
      spec          TEXT NOT NULL,
      status        TEXT NOT NULL,
      progress      REAL NOT NULL DEFAULT 0,
      file_path     TEXT,
      thumb_path    TEXT,
      bytes         INTEGER,
      duration      REAL,
      public_token  TEXT NOT NULL UNIQUE,
      error         TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    INSERT INTO clips_migrated
      (id, recording_id, source_title, title, start_sec, end_sec, spec, status, progress,
       file_path, thumb_path, bytes, duration, public_token, error, created_at, updated_at)
    SELECT c.id, c.recording_id, r.title, c.title, c.start_sec, c.end_sec, c.spec, c.status, c.progress,
           c.file_path, c.thumb_path, c.bytes, c.duration, c.public_token, c.error, c.created_at, c.updated_at
    FROM clips c LEFT JOIN recordings r ON r.id = c.recording_id;
    DROP TABLE clips;
    ALTER TABLE clips_migrated RENAME TO clips;
    CREATE INDEX IF NOT EXISTS clips_recording ON clips(recording_id, created_at DESC);
    COMMIT;
  `);
  db.pragma('foreign_keys = ON');
  log.info('clips migration done');
}

export function runMigrations(db: Database): void {
  detachClipsFromRecordings(db);
}
