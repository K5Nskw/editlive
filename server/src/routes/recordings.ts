import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.ts';
import type { ClipRow, HighlightRow, RecordingRow, StreamRow } from '../db/types.ts';
import { readAnalysis } from '../media/analyze.ts';
import { enqueueJob } from '../jobs/queue.ts';
import { removeRecordingFiles } from '../util/storage.ts';
import { clipDto, highlightDto, recordingDto } from './serialize.ts';

export const recordingsRouter: Router = Router();

const analyzeBody = z.object({
  sensitivity: z.number().min(0).max(1).optional(),
  maxCandidates: z.number().int().min(1).max(60).optional(),
});

function findRecording(id: string): RecordingRow | undefined {
  return db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as RecordingRow | undefined;
}

function streamOf(rec: RecordingRow): StreamRow | undefined {
  return db.prepare('SELECT * FROM streams WHERE id = ?').get(rec.stream_id) as StreamRow | undefined;
}

recordingsRouter.get('/', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
  const rows = db.prepare('SELECT * FROM recordings ORDER BY started_at DESC LIMIT ?').all(limit) as RecordingRow[];
  res.json({
    recordings: rows.map((row) => ({
      ...recordingDto(row, streamOf(row)),
      clipCount: (
        db.prepare('SELECT COUNT(*) AS n FROM clips WHERE recording_id = ?').get(row.id) as { n: number }
      ).n,
      highlightCount: (
        db.prepare('SELECT COUNT(*) AS n FROM highlights WHERE recording_id = ?').get(row.id) as { n: number }
      ).n,
    })),
  });
});

recordingsRouter.get('/:id', (req, res) => {
  const rec = findRecording(req.params.id);
  if (!rec) {
    res.status(404).json({ error: 'recording not found' });
    return;
  }
  const highlights = db
    .prepare('SELECT * FROM highlights WHERE recording_id = ? ORDER BY score DESC')
    .all(rec.id) as HighlightRow[];
  const clips = db
    .prepare('SELECT * FROM clips WHERE recording_id = ? ORDER BY created_at DESC')
    .all(rec.id) as ClipRow[];

  res.json({
    recording: recordingDto(rec, streamOf(rec)),
    highlights: highlights.map(highlightDto),
    clips: clips.map(clipDto),
  });
});

/** The excitement curve powering the timeline; large, so it is its own request. */
recordingsRouter.get('/:id/analysis', (req, res) => {
  const rec = findRecording(req.params.id);
  if (!rec) {
    res.status(404).json({ error: 'recording not found' });
    return;
  }
  const analysis = readAnalysis(rec.dir);
  if (!analysis) {
    res.status(404).json({ error: 'analysis is not available yet', status: rec.analysis_status });
    return;
  }
  res.json({ analysis });
});

recordingsRouter.post('/:id/analyze', (req, res) => {
  const rec = findRecording(req.params.id);
  if (!rec) {
    res.status(404).json({ error: 'recording not found' });
    return;
  }
  if (rec.status === 'live') {
    res.status(409).json({ error: '配信中の録画はまだ解析できません' });
    return;
  }
  const parsed = analyzeBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }
  const jobId = enqueueJob('analyze', { recordingId: rec.id, ...parsed.data });
  db.prepare("UPDATE recordings SET analysis_status = 'pending' WHERE id = ?").run(rec.id);
  res.status(202).json({ jobId });
});

recordingsRouter.patch('/:id', (req, res) => {
  const rec = findRecording(req.params.id);
  if (!rec) {
    res.status(404).json({ error: 'recording not found' });
    return;
  }
  const parsed = z.object({ title: z.string().trim().min(1).max(200) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  db.prepare('UPDATE recordings SET title = ? WHERE id = ?').run(parsed.data.title, rec.id);
  res.json({ recording: recordingDto(findRecording(rec.id)!, streamOf(rec)) });
});

recordingsRouter.delete('/:id', (req, res) => {
  const rec = findRecording(req.params.id);
  if (!rec) {
    res.status(404).json({ error: 'recording not found' });
    return;
  }
  if (rec.status === 'live') {
    res.status(409).json({ error: '配信中の録画は削除できません' });
    return;
  }
  removeRecordingFiles(rec.id);
  db.prepare('DELETE FROM recordings WHERE id = ?').run(rec.id);
  res.status(204).end();
});
