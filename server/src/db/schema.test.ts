import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');

function seed() {
  const db = new Database(':memory:');
  db.exec(schema);
  db.pragma('foreign_keys = ON');
  db.prepare('INSERT INTO streams (id, name, stream_key, auto_record, created_at) VALUES (?, ?, ?, 1, 0)').run(
    'stm_1',
    'stream',
    'key',
  );
  db.prepare(
    `INSERT INTO recordings (id, stream_id, title, status, analysis_status, started_at, dir)
     VALUES ('rec_1', 'stm_1', '配信', 'ready', 'ready', 0, '/tmp/rec_1')`,
  ).run();
  for (const id of ['clip_a', 'clip_b']) {
    db.prepare(
      `INSERT INTO clips (id, recording_id, source_title, title, start_sec, end_sec, spec, status, public_token, created_at, updated_at)
       VALUES (?, 'rec_1', NULL, ?, 0, 5, '{}', 'ready', ?, 0, 0)`,
    ).run(id, id, `token_${id}`);
    db.prepare(
      `INSERT INTO publications (id, clip_id, target, status, created_at, updated_at)
       VALUES (?, ?, 'webhook', 'done', 0, 0)`,
    ).run(`pub_${id}`, id);
  }
  return db;
}

const count = (db: Database.Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/**
 * The foreign key only detaches clips, so deleting them with their recording is
 * a deliberate step. Forgetting it leaves rows pointing at files that are gone.
 */
test('deleting a recording with its clips leaves nothing behind', () => {
  const db = seed();
  db.prepare('DELETE FROM clips WHERE recording_id = ?').run('rec_1');
  db.prepare('DELETE FROM recordings WHERE id = ?').run('rec_1');

  assert.equal(count(db, 'recordings'), 0);
  assert.equal(count(db, 'clips'), 0);
  assert.equal(count(db, 'publications'), 0, 'publications cascade off their clip');
  db.close();
});

test('deleting a recording on its own keeps the clips, detached', () => {
  const db = seed();
  db.prepare('UPDATE clips SET source_title = COALESCE(source_title, ?) WHERE recording_id = ?').run('配信', 'rec_1');
  db.prepare('DELETE FROM recordings WHERE id = ?').run('rec_1');

  assert.equal(count(db, 'recordings'), 0);
  assert.equal(count(db, 'clips'), 2);
  assert.equal(count(db, 'publications'), 2);
  const rows = db.prepare('SELECT recording_id, source_title FROM clips').all() as Array<{
    recording_id: string | null;
    source_title: string | null;
  }>;
  for (const row of rows) {
    assert.equal(row.recording_id, null, 'the link is cleared, not the row');
    assert.equal(row.source_title, '配信', 'where it came from survives the recording');
  }
  db.close();
});

test('deleting a stream takes its recordings and their clips', () => {
  const db = seed();
  db.prepare('DELETE FROM clips WHERE recording_id IN (SELECT id FROM recordings WHERE stream_id = ?)').run('stm_1');
  db.prepare('DELETE FROM streams WHERE id = ?').run('stm_1');

  assert.equal(count(db, 'recordings'), 0, 'recordings cascade off their stream');
  assert.equal(count(db, 'clips'), 0);
  db.close();
});
