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

/**
 * Drop clips that claim to be finished but whose file is gone. Earlier versions
 * deleted a recording's clip files while leaving the rows behind, so a
 * deployment can be carrying entries that list and link to nothing. Rows still
 * waiting on a render are left alone — they have no file yet by definition.
 */
export function reconcileClips(): void {
  const stale = db
    .prepare("SELECT * FROM clips WHERE status = 'ready' AND file_path IS NOT NULL")
    .all() as ClipRow[];
  const missing = stale.filter((clip) => !fs.existsSync(clip.file_path!));
  if (missing.length === 0) return;

  const remove = db.prepare('DELETE FROM clips WHERE id = ?');
  for (const clip of missing) {
    removeClipFiles(clip);
    remove.run(clip.id);
  }
  log.warn(`removed ${missing.length} clip(s) whose rendered file no longer exists`);
}
