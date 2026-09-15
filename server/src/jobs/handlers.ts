import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { db } from '../db/index.ts';
import type { ClipRow, RecordingRow } from '../db/types.ts';
import { analyzeSource, writeAnalysis } from '../media/analyze.ts';
import { probe, runFfmpeg } from '../media/ffmpeg.ts';
import { extractThumbnail, generateSprite, renderClip, type RenderSpec } from '../media/render.ts';
import { HLS_PLAYLIST, MASTER_FILE, SOURCE_FILE, sourceFor } from '../ingest/recorder.ts';
import { runPublication } from '../publish/index.ts';
import { createLogger } from '../util/logger.ts';
import { enqueueJob, registerJobHandler, type JobContext } from './queue.ts';

const log = createLogger('handlers');

function getRecording(id: string): RecordingRow {
  const rec = db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as RecordingRow | undefined;
  if (!rec) throw new Error(`recording ${id} not found`);
  return rec;
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value === '') throw new Error(`job payload is missing "${key}"`);
  return value;
}

/**
 * Turn the crash-safe fragmented capture into a seekable faststart MP4 and
 * build the assets the editor needs (poster, timeline filmstrip).
 */
async function postprocess(payload: Record<string, unknown>, ctx: JobContext): Promise<void> {
  const rec = getRecording(requireString(payload, 'recordingId'));
  const raw = path.join(rec.dir, SOURCE_FILE);
  const playlist = path.join(rec.dir, HLS_PLAYLIST);
  const input = fs.existsSync(raw) ? raw : playlist;
  if (!fs.existsSync(input)) throw new Error('no captured media found for this recording');

  const master = path.join(rec.dir, MASTER_FILE);
  const fromHls = input === playlist;
  try {
    await runFfmpeg(
      [
        '-hide_banner', '-nostdin', '-v', 'error', '-y',
        ...(fromHls ? ['-allowed_extensions', 'ALL'] : []),
        '-i', input,
        '-c', 'copy',
        ...(fromHls ? ['-bsf:a', 'aac_adtstoasc'] : []),
        '-movflags', '+faststart',
        master,
      ],
      { signal: ctx.signal, tailLines: 30 },
    );
  } catch (err) {
    // A truncated capture still plays; keep the raw file as the source.
    fs.rmSync(master, { force: true });
    log.warn(`remux failed for ${rec.id}, falling back to the raw capture`, err);
  }

  const source = sourceFor(rec);
  const info = await probe(source);
  db.prepare(
    `UPDATE recordings SET status = 'ready', duration = ?, width = ?, height = ?, fps = ?, error = NULL WHERE id = ?`,
  ).run(info.duration, info.width, info.height, info.fps, rec.id);

  if (info.duration > 0) {
    try {
      await extractThumbnail(source, Math.min(info.duration * 0.1, 30), path.join(rec.dir, 'poster.jpg'));
      const sprite = await generateSprite(source, rec.dir, info.duration, info);
      fs.writeFileSync(path.join(rec.dir, 'sprite.json'), JSON.stringify(sprite));
    } catch (err) {
      log.warn(`thumbnail generation failed for ${rec.id}`, err);
    }
  }

  enqueueJob('analyze', { recordingId: rec.id });
}

/** Builds the loudness/motion curve and cut markers the editor timeline draws. */
async function analyze(payload: Record<string, unknown>, ctx: JobContext): Promise<void> {
  const rec = getRecording(requireString(payload, 'recordingId'));

  db.prepare("UPDATE recordings SET analysis_status = 'running' WHERE id = ?").run(rec.id);
  try {
    const analysis = await analyzeSource(sourceFor(rec), ctx.signal);
    writeAnalysis(rec.dir, analysis);
    db.prepare("UPDATE recordings SET analysis_status = 'ready' WHERE id = ?").run(rec.id);
  } catch (err) {
    db.prepare("UPDATE recordings SET analysis_status = 'failed' WHERE id = ?").run(rec.id);
    throw err;
  }
}

async function render(payload: Record<string, unknown>, ctx: JobContext): Promise<void> {
  const clipId = requireString(payload, 'clipId');
  const clip = db.prepare('SELECT * FROM clips WHERE id = ?').get(clipId) as ClipRow | undefined;
  if (!clip) throw new Error(`clip ${clipId} not found`);
  const rec = getRecording(clip.recording_id);

  const source = sourceFor(rec);
  const info = await probe(source);
  const outFile = path.join(config.clipsDir, `${clip.id}.mp4`);
  const spec = JSON.parse(clip.spec) as RenderSpec;

  db.prepare("UPDATE clips SET status = 'rendering', progress = 0, error = NULL, updated_at = ? WHERE id = ?").run(
    Date.now(),
    clip.id,
  );

  let lastWrite = 0;
  try {
    const result = await renderClip({
      source,
      start: clip.start_sec,
      end: clip.end_sec,
      spec,
      outFile,
      hasAudio: info.hasAudio,
      signal: ctx.signal,
      onProgress: (fraction) => {
        const now = Date.now();
        if (now - lastWrite < 700) return;
        lastWrite = now;
        db.prepare('UPDATE clips SET progress = ?, updated_at = ? WHERE id = ?').run(fraction, now, clip.id);
      },
    });

    const thumb = path.join(config.clipsDir, `${clip.id}.jpg`);
    try {
      await extractThumbnail(outFile, Math.min(1, result.duration / 2), thumb, 480);
    } catch (err) {
      log.warn(`clip thumbnail failed for ${clip.id}`, err);
    }

    db.prepare(
      `UPDATE clips SET status = 'ready', progress = 1, file_path = ?, thumb_path = ?, bytes = ?, duration = ?,
       error = NULL, updated_at = ? WHERE id = ?`,
    ).run(outFile, fs.existsSync(thumb) ? thumb : null, result.bytes, result.duration, Date.now(), clip.id);
  } catch (err) {
    fs.rmSync(outFile, { force: true });
    const message = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE clips SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
      message.slice(0, 1000),
      Date.now(),
      clip.id,
    );
    throw err;
  }
}

async function publish(payload: Record<string, unknown>, ctx: JobContext): Promise<void> {
  await runPublication(requireString(payload, 'publicationId'), ctx.signal);
}

export function registerHandlers(): void {
  registerJobHandler('postprocess', postprocess);
  registerJobHandler('analyze', analyze);
  registerJobHandler('render', render);
  registerJobHandler('publish', publish);
}
