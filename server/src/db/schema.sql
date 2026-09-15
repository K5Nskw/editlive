PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS streams (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  stream_key   TEXT NOT NULL UNIQUE,
  auto_record  INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

-- One row per publish session (an encoder connecting and disconnecting).
CREATE TABLE IF NOT EXISTS recordings (
  id              TEXT PRIMARY KEY,
  stream_id       TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL,             -- live | processing | ready | failed
  analysis_status TEXT NOT NULL DEFAULT 'pending', -- pending | running | ready | failed
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  duration        REAL NOT NULL DEFAULT 0,
  width           INTEGER,
  height          INTEGER,
  fps             REAL,
  bytes           INTEGER NOT NULL DEFAULT 0,
  dir             TEXT NOT NULL,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS recordings_started ON recordings(started_at DESC);

-- Auto-detected clip candidates (the "WSC style" part of the pipeline).
CREATE TABLE IF NOT EXISTS highlights (
  id            TEXT PRIMARY KEY,
  recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  start_sec     REAL NOT NULL,
  end_sec       REAL NOT NULL,
  peak          REAL NOT NULL,
  score         REAL NOT NULL,
  reason        TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS highlights_recording ON highlights(recording_id, score DESC);

CREATE TABLE IF NOT EXISTS clips (
  id            TEXT PRIMARY KEY,
  recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  start_sec     REAL NOT NULL,
  end_sec       REAL NOT NULL,
  spec          TEXT NOT NULL,             -- JSON RenderSpec
  status        TEXT NOT NULL,             -- queued | rendering | ready | failed
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
CREATE INDEX IF NOT EXISTS clips_recording ON clips(recording_id, created_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,               -- postprocess | analyze | render | publish
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL,               -- queued | running | done | failed
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status, created_at);

CREATE TABLE IF NOT EXISTS publications (
  id          TEXT PRIMARY KEY,
  clip_id     TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  target      TEXT NOT NULL,               -- youtube | buffer | webhook
  status      TEXT NOT NULL,               -- queued | uploading | done | failed
  options     TEXT NOT NULL DEFAULT '{}',
  remote_id   TEXT,
  remote_url  TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS publications_clip ON publications(clip_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
