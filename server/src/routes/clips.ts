import fs from 'node:fs';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { db } from '../db/index.ts';
import type { ClipRow, PublicationRow, RecordingRow } from '../db/types.ts';
import { enqueueJob } from '../jobs/queue.ts';
import { ASPECTS, DEFAULT_SPEC, FIT_MODES, type RenderSpec } from '../media/render.ts';
import { createPublication, type PublishOptions } from '../publish/index.ts';
import { newId, newToken } from '../util/ids.ts';
import { removeClipFiles } from '../util/storage.ts';
import { clipDto, publicationDto } from './serialize.ts';

export const clipsRouter: Router = Router();

const specSchema = z.object({
  aspect: z.enum(ASPECTS).optional(),
  fit: z.enum(FIT_MODES).optional(),
  focusX: z.number().min(0).max(1).optional(),
  focusY: z.number().min(0).max(1).optional(),
  resolution: z.number().int().min(360).max(2160).optional(),
  mute: z.boolean().optional(),
  fadeIn: z.number().min(0).max(5).optional(),
  fadeOut: z.number().min(0).max(5).optional(),
  overlayText: z.string().max(300).optional(),
  overlayPosition: z.enum(['top', 'bottom']).optional(),
});

const createBody = z.object({
  recordingId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  start: z.number().min(0),
  end: z.number().min(0),
  spec: specSchema.optional(),
});

const publishBody = z.object({
  target: z.enum(['youtube', 'buffer', 'webhook']),
  options: z
    .object({
      title: z.string().max(200).optional(),
      description: z.string().max(5000).optional(),
      tags: z.array(z.string().max(60)).max(30).optional(),
      privacyStatus: z.enum(['private', 'unlisted', 'public']).optional(),
      profileIds: z.array(z.string()).optional(),
      text: z.string().max(2000).optional(),
      now: z.boolean().optional(),
      url: z.url().optional(),
    })
    .optional(),
});

function findClip(id: string): ClipRow | undefined {
  return db.prepare('SELECT * FROM clips WHERE id = ?').get(id) as ClipRow | undefined;
}

function mergeSpec(partial: z.infer<typeof specSchema> | undefined): RenderSpec {
  return { ...DEFAULT_SPEC, ...(partial ?? {}) };
}

clipsRouter.get('/', (req, res) => {
  const recordingId = typeof req.query.recordingId === 'string' ? req.query.recordingId : undefined;
  const rows = (
    recordingId
      ? db.prepare('SELECT * FROM clips WHERE recording_id = ? ORDER BY created_at DESC').all(recordingId)
      : db.prepare('SELECT * FROM clips ORDER BY created_at DESC LIMIT 200').all()
  ) as ClipRow[];
  res.json({ clips: rows.map(clipDto) });
});

clipsRouter.post('/', (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid clip', details: parsed.error.issues });
    return;
  }
  const { recordingId, title, start, end } = parsed.data;
  const rec = db.prepare('SELECT * FROM recordings WHERE id = ?').get(recordingId) as RecordingRow | undefined;
  if (!rec) {
    res.status(404).json({ error: 'recording not found' });
    return;
  }
  if (end - start < 0.5) {
    res.status(400).json({ error: 'クリップの長さが短すぎます' });
    return;
  }

  const id = newId('clip_');
  const now = Date.now();
  db.prepare(
    `INSERT INTO clips (id, recording_id, source_title, title, start_sec, end_sec, spec, status, progress, public_token, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
  ).run(id, rec.id, rec.title, title, start, end, JSON.stringify(mergeSpec(parsed.data.spec)), newToken(), now, now);

  enqueueJob('render', { clipId: id });
  res.status(201).json({ clip: clipDto(findClip(id)!) });
});

clipsRouter.get('/:id', (req, res) => {
  const clip = findClip(req.params.id);
  if (!clip) {
    res.status(404).json({ error: 'clip not found' });
    return;
  }
  const publications = db
    .prepare('SELECT * FROM publications WHERE clip_id = ? ORDER BY created_at DESC')
    .all(clip.id) as PublicationRow[];
  res.json({ clip: clipDto(clip), publications: publications.map(publicationDto) });
});

clipsRouter.patch('/:id', (req, res) => {
  const clip = findClip(req.params.id);
  if (!clip) {
    res.status(404).json({ error: 'clip not found' });
    return;
  }
  const parsed = z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      start: z.number().min(0).optional(),
      end: z.number().min(0).optional(),
      spec: specSchema.optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }

  const start = parsed.data.start ?? clip.start_sec;
  const end = parsed.data.end ?? clip.end_sec;
  const spec = parsed.data.spec ? { ...(JSON.parse(clip.spec) as RenderSpec), ...parsed.data.spec } : undefined;
  db.prepare('UPDATE clips SET title = COALESCE(?, title), start_sec = ?, end_sec = ?, spec = COALESCE(?, spec), updated_at = ? WHERE id = ?').run(
    parsed.data.title ?? null,
    start,
    end,
    spec ? JSON.stringify(spec) : null,
    Date.now(),
    clip.id,
  );

  // Any change to the cut or the look needs a new render.
  const changed = parsed.data.start !== undefined || parsed.data.end !== undefined || parsed.data.spec !== undefined;
  if (changed) {
    removeClipFiles(clip);
    db.prepare("UPDATE clips SET status = 'queued', progress = 0, file_path = NULL, thumb_path = NULL, error = NULL WHERE id = ?").run(clip.id);
    enqueueJob('render', { clipId: clip.id });
  }
  res.json({ clip: clipDto(findClip(clip.id)!) });
});

clipsRouter.post('/:id/rerender', (req, res) => {
  const clip = findClip(req.params.id);
  if (!clip) {
    res.status(404).json({ error: 'clip not found' });
    return;
  }
  removeClipFiles(clip);
  db.prepare("UPDATE clips SET status = 'queued', progress = 0, file_path = NULL, thumb_path = NULL, error = NULL, updated_at = ? WHERE id = ?").run(
    Date.now(),
    clip.id,
  );
  const jobId = enqueueJob('render', { clipId: clip.id });
  res.status(202).json({ jobId, clip: clipDto(findClip(clip.id)!) });
});

clipsRouter.delete('/:id', (req, res) => {
  const clip = findClip(req.params.id);
  if (!clip) {
    res.status(404).json({ error: 'clip not found' });
    return;
  }
  removeClipFiles(clip);
  db.prepare('DELETE FROM clips WHERE id = ?').run(clip.id);
  res.status(204).end();
});

function sendClipFile(id: string, kind: 'file' | 'download' | 'thumb', res: Response): void {
  const clip = db.prepare('SELECT * FROM clips WHERE id = ?').get(id) as ClipRow | undefined;
  const file = kind === 'thumb' ? clip?.thumb_path : clip?.file_path;
  if (!clip || !file || !fs.existsSync(file)) {
    res.status(404).json({ error: 'file not found' });
    return;
  }
  res.type(kind === 'thumb' ? 'image/jpeg' : 'video/mp4');
  if (kind === 'download') {
    const name = `${clip.title.replace(/[^\w\-. ぁ-んァ-ヶ一-龠]/g, '_').slice(0, 60) || 'clip'}.mp4`;
    res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  res.sendFile(file);
}

clipsRouter.get('/:id/file', (req, res) => sendClipFile(req.params.id, 'file', res));
clipsRouter.get('/:id/download', (req, res) => sendClipFile(req.params.id, 'download', res));
clipsRouter.get('/:id/thumb', (req, res) => sendClipFile(req.params.id, 'thumb', res));

clipsRouter.post('/:id/publish', (req, res) => {
  const clip = findClip(req.params.id);
  if (!clip) {
    res.status(404).json({ error: 'clip not found' });
    return;
  }
  const parsed = publishBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid publish request', details: parsed.error.issues });
    return;
  }
  const publication = createPublication(clip.id, parsed.data.target, (parsed.data.options ?? {}) as PublishOptions);
  res.status(202).json({ publication: publicationDto(publication) });
});
