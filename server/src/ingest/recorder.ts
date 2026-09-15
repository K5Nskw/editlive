import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { db } from '../db/index.ts';
import type { RecordingRow, StreamRow } from '../db/types.ts';
import { spawnFfmpeg, type LongRunningProcess } from '../media/ffmpeg.ts';
import { enqueueJob } from '../jobs/queue.ts';
import { newId } from '../util/ids.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('recorder');

interface Active {
  recordingId: string;
  streamId: string;
  dir: string;
  proc: LongRunningProcess;
  startedAt: number;
  bytesTimer: NodeJS.Timeout;
}

const active = new Map<string, Active>(); // keyed by stream id

/**
 * The tail of what the recorder's ffmpeg said, per recording. It runs with
 * -loglevel warning, so anything it emits is worth seeing: this is the only
 * explanation available when a live stream records but will not play.
 */
const recorderMessages = new Map<string, string[]>();
const MESSAGE_LIMIT = 12;

export function recorderLog(recordingId: string): string[] {
  return recorderMessages.get(recordingId) ?? [];
}

/** Live progress of the HLS output, which is what the browser plays back. */
export function liveProgress(dir: string): { segments: number; playlist: boolean; lastSegmentAt: number | null } {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return { segments: 0, playlist: false, lastSegmentAt: null };
  }
  const segments = files.filter((f) => /^seg_\d+\.ts$/.test(f));
  let newest = 0;
  for (const file of segments) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(dir, file)).mtimeMs);
    } catch {
      /* rotated away mid-scan */
    }
  }
  return {
    segments: segments.length,
    playlist: files.includes(HLS_PLAYLIST),
    lastSegmentAt: newest || null,
  };
}

export const HLS_PLAYLIST = 'index.m3u8';
export const SOURCE_FILE = 'source.mp4';
export const MASTER_FILE = 'master.mp4';

export function recordingDir(recordingId: string): string {
  return path.join(config.recordingsDir, recordingId);
}

/**
 * The best source for reading a recording back: the finalised remux when
 * post-processing is done, the raw capture next, the live HLS playlist while
 * the encoder is still connected.
 */
export function sourceFor(rec: Pick<RecordingRow, 'dir'>): string {
  for (const name of [MASTER_FILE, SOURCE_FILE, HLS_PLAYLIST]) {
    const p = path.join(rec.dir, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(rec.dir, HLS_PLAYLIST);
}

export function isLive(streamId: string): boolean {
  return active.has(streamId);
}

export function activeRecordingId(streamId: string): string | undefined {
  return active.get(streamId)?.recordingId;
}

function directorySize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* file vanished mid-scan */
      }
    }
  }
  return total;
}

function ffmpegArgs(streamKey: string, dir: string): string[] {
  const input = `rtmp://127.0.0.1:${config.rtmpPort}/${config.rtmpApp}/${encodeURIComponent(streamKey)}`;
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-nostdin',
    '-fflags', '+genpts',
    '-rw_timeout', '15000000',
    '-i', input,
    '-t', String(config.maxRecordingSeconds),

    // Live/scrubbable HLS. An event playlist keeps every segment, so the editor
    // can seek back through the whole session while it is still being recorded.
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', String(config.hlsSegmentSeconds),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
    path.join(dir, HLS_PLAYLIST),

    // Fragmented MP4 capture: survives an abrupt kill without losing the file,
    // and is remuxed to a faststart MP4 during post-processing.
    '-c', 'copy',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    path.join(dir, SOURCE_FILE),
  ];
}

export function startRecording(stream: StreamRow): RecordingRow | undefined {
  if (active.has(stream.id)) {
    log.warn(`stream ${stream.name} is already recording`);
    return undefined;
  }

  const recordingId = newId('rec_');
  const dir = recordingDir(recordingId);
  fs.mkdirSync(dir, { recursive: true });

  const now = Date.now();
  const title = `${stream.name} — ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}`;
  db.prepare(
    `INSERT INTO recordings (id, stream_id, title, status, analysis_status, started_at, dir)
     VALUES (?, ?, ?, 'live', 'pending', ?, ?)`,
  ).run(recordingId, stream.id, title, now, dir);

  // The publisher is registered right after the postPublish handler returns, so
  // give the broadcast a moment before ffmpeg subscribes to it.
  recorderMessages.set(recordingId, []);
  const proc = spawnFfmpeg(ffmpegArgs(stream.stream_key, dir), (line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    const messages = recorderMessages.get(recordingId) ?? [];
    messages.push(trimmed);
    if (messages.length > MESSAGE_LIMIT) messages.shift();
    recorderMessages.set(recordingId, messages);
    log.warn(`[${recordingId}] ${trimmed}`);
  });

  const bytesTimer = setInterval(() => {
    const bytes = directorySize(dir);
    db.prepare('UPDATE recordings SET bytes = ? WHERE id = ?').run(bytes, recordingId);
  }, 10_000);
  bytesTimer.unref();

  active.set(stream.id, { recordingId, streamId: stream.id, dir, proc, startedAt: now, bytesTimer });

  void proc.exited.then((code) => {
    const entry = active.get(stream.id);
    if (entry?.recordingId === recordingId) {
      // ffmpeg died on its own (input ended, codec unsupported, disk full).
      log.info(`recorder for ${recordingId} exited with code ${code}`);
      void stopRecording(stream.id);
    }
  });

  log.info(`recording ${recordingId} started for stream ${stream.name}`);
  return db.prepare('SELECT * FROM recordings WHERE id = ?').get(recordingId) as RecordingRow;
}

export async function stopRecording(streamId: string): Promise<void> {
  const entry = active.get(streamId);
  if (!entry) return;
  active.delete(streamId);
  clearInterval(entry.bytesTimer);

  await entry.proc.stop();

  const bytes = directorySize(entry.dir);
  const hasMedia = fs.existsSync(path.join(entry.dir, SOURCE_FILE)) || fs.existsSync(path.join(entry.dir, HLS_PLAYLIST));
  const progress = liveProgress(entry.dir);
  if (progress.segments === 0) {
    log.warn(`recording ${entry.recordingId} produced no HLS segments; live preview would have been blank`);
  }

  db.prepare('UPDATE recordings SET status = ?, ended_at = ?, bytes = ?, error = ? WHERE id = ?').run(
    hasMedia ? 'processing' : 'failed',
    Date.now(),
    bytes,
    hasMedia ? null : 'no media was captured (check that the encoder sends H.264/AAC)',
    entry.recordingId,
  );

  if (hasMedia) enqueueJob('postprocess', { recordingId: entry.recordingId });
  log.info(`recording ${entry.recordingId} stopped (${(bytes / 1e6).toFixed(1)} MB)`);
}

export async function stopAll(): Promise<void> {
  await Promise.all([...active.keys()].map((streamId) => stopRecording(streamId)));
}

/** Recordings left in a running state by a crash are recovered at boot. */
export function recoverInterruptedRecordings(): void {
  const stale = db.prepare("SELECT * FROM recordings WHERE status = 'live'").all() as RecordingRow[];
  for (const rec of stale) {
    const hasMedia = fs.existsSync(path.join(rec.dir, SOURCE_FILE)) || fs.existsSync(path.join(rec.dir, HLS_PLAYLIST));
    db.prepare('UPDATE recordings SET status = ?, ended_at = COALESCE(ended_at, ?), error = ? WHERE id = ?').run(
      hasMedia ? 'processing' : 'failed',
      Date.now(),
      hasMedia ? null : 'the server restarted before any media was captured',
      rec.id,
    );
    if (hasMedia) enqueueJob('postprocess', { recordingId: rec.id });
    log.warn(`recovered interrupted recording ${rec.id}`);
  }
}
