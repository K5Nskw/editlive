import fs from 'node:fs';
import path from 'node:path';
import { Router, type Response } from 'express';
import { db } from '../db/index.ts';
import type { ClipRow, RecordingRow } from '../db/types.ts';
import { requireAuth } from '../auth.ts';

/** Only the artefacts the editor needs; never an arbitrary path inside the volume. */
const ALLOWED_RECORDING_FILES = /^(index\.m3u8|master\.mp4|source\.mp4|poster\.jpg|analysis\.json|sprite\.json|sprite_\d+\.jpg|seg_\d+\.ts)$/;

const CONTENT_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

function send(res: Response, file: string, { download }: { download?: string } = {}): void {
  const type = CONTENT_TYPES[path.extname(file)];
  if (type) res.type(type);
  if (file.endsWith('.m3u8')) res.setHeader('cache-control', 'no-cache');
  if (download) res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(download)}"`);
  res.sendFile(file);
}

/** Authenticated recording assets, mounted at /media/recordings. */
export const recordingMediaRouter: Router = Router();

recordingMediaRouter.use(requireAuth);

recordingMediaRouter.get('/:id/:file', (req, res) => {
  const rec = db.prepare('SELECT * FROM recordings WHERE id = ?').get(req.params.id) as RecordingRow | undefined;
  const file = path.basename(req.params.file);
  if (!rec || !ALLOWED_RECORDING_FILES.test(file)) {
    res.status(404).json({ error: 'file not found' });
    return;
  }
  const full = path.join(rec.dir, file);
  if (!fs.existsSync(full)) {
    res.status(404).json({ error: 'file not found' });
    return;
  }
  send(res, full);
});

/**
 * Unauthenticated share links, mounted at /p. The token is per clip, so a link
 * can be handed to Buffer or a webhook consumer without exposing the app.
 */
export const publicMediaRouter: Router = Router();

publicMediaRouter.get('/:token', (req, res) => {
  const raw = req.params.token;
  const ext = path.extname(raw);
  const token = raw.slice(0, raw.length - ext.length);
  const clip = db.prepare('SELECT * FROM clips WHERE public_token = ?').get(token) as ClipRow | undefined;
  if (!clip || clip.status !== 'ready') {
    res.status(404).json({ error: 'clip not found' });
    return;
  }
  const file = ext === '.jpg' ? clip.thumb_path : clip.file_path;
  if (!file || !fs.existsSync(file)) {
    res.status(404).json({ error: 'clip not found' });
    return;
  }
  res.setHeader('cache-control', 'public, max-age=3600');
  send(res, file);
});
