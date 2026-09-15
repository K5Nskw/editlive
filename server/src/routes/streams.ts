import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.ts';
import type { StreamRow } from '../db/types.ts';
import { isLive } from '../ingest/recorder.ts';
import { newId, newStreamKey } from '../util/ids.ts';
import { removeRecordingFiles } from '../util/storage.ts';
import { streamDto } from './serialize.ts';

export const streamsRouter: Router = Router();

const createBody = z.object({ name: z.string().trim().min(1).max(80) });
const patchBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  autoRecord: z.boolean().optional(),
});

function findStream(id: string): StreamRow | undefined {
  return db.prepare('SELECT * FROM streams WHERE id = ?').get(id) as StreamRow | undefined;
}

streamsRouter.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM streams ORDER BY created_at').all() as StreamRow[];
  res.json({ streams: rows.map(streamDto) });
});

streamsRouter.post('/', (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const id = newId('stm_');
  db.prepare('INSERT INTO streams (id, name, stream_key, auto_record, created_at) VALUES (?, ?, ?, 1, ?)').run(
    id,
    parsed.data.name,
    newStreamKey(),
    Date.now(),
  );
  res.status(201).json({ stream: streamDto(findStream(id)!) });
});

streamsRouter.patch('/:id', (req, res) => {
  const stream = findStream(req.params.id);
  if (!stream) {
    res.status(404).json({ error: 'stream not found' });
    return;
  }
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }
  db.prepare('UPDATE streams SET name = COALESCE(?, name), auto_record = COALESCE(?, auto_record) WHERE id = ?').run(
    parsed.data.name ?? null,
    parsed.data.autoRecord === undefined ? null : Number(parsed.data.autoRecord),
    stream.id,
  );
  res.json({ stream: streamDto(findStream(stream.id)!) });
});

streamsRouter.post('/:id/rotate-key', (req, res) => {
  const stream = findStream(req.params.id);
  if (!stream) {
    res.status(404).json({ error: 'stream not found' });
    return;
  }
  db.prepare('UPDATE streams SET stream_key = ? WHERE id = ?').run(newStreamKey(), stream.id);
  res.json({ stream: streamDto(findStream(stream.id)!) });
});

streamsRouter.delete('/:id', (req, res) => {
  const stream = findStream(req.params.id);
  if (!stream) {
    res.status(404).json({ error: 'stream not found' });
    return;
  }
  if (isLive(stream.id)) {
    res.status(409).json({ error: '受信中の入力は削除できません' });
    return;
  }
  // Rows cascade, but the media on disk has to be removed explicitly.
  const recordings = db.prepare('SELECT id FROM recordings WHERE stream_id = ?').all(stream.id) as Array<{ id: string }>;
  for (const rec of recordings) removeRecordingFiles(rec.id);
  db.prepare('DELETE FROM streams WHERE id = ?').run(stream.id);
  res.status(204).end();
});
