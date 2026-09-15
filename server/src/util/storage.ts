import fs from 'node:fs';
import { db } from '../db/index.ts';
import type { ClipRow, RecordingRow } from '../db/types.ts';
import { createLogger } from './logger.ts';

const log = createLogger('storage');

function removeQuietly(target: string | null | undefined): void {
  if (!target) return;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    log.warn(`could not remove ${target}`, err);
  }
}

export function removeClipFiles(clip: Pick<ClipRow, 'file_path' | 'thumb_path'>): void {
  removeQuietly(clip.file_path);
  removeQuietly(clip.thumb_path);
}

/** Delete every file belonging to a recording, including its rendered clips. */
export function removeRecordingFiles(recordingId: string): void {
  const rec = db.prepare('SELECT * FROM recordings WHERE id = ?').get(recordingId) as RecordingRow | undefined;
  const clips = db.prepare('SELECT * FROM clips WHERE recording_id = ?').all(recordingId) as ClipRow[];
  for (const clip of clips) removeClipFiles(clip);
  if (rec) removeQuietly(rec.dir);
}
