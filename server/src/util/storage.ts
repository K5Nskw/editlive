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

/**
 * Delete a recording's files. Its clips go too unless they are being kept, in
 * which case only the captured material is removed and the exports stay
 * playable on their own.
 */
export function removeRecordingFiles(recordingId: string, options: { keepClips?: boolean } = {}): void {
  const rec = db.prepare('SELECT * FROM recordings WHERE id = ?').get(recordingId) as RecordingRow | undefined;
  if (!options.keepClips) {
    const clips = db.prepare('SELECT * FROM clips WHERE recording_id = ?').all(recordingId) as ClipRow[];
    for (const clip of clips) removeClipFiles(clip);
  }
  if (rec) removeQuietly(rec.dir);
}
