import fs from 'node:fs';
import path from 'node:path';
import type { ClipRow, JobRow, PublicationRow, RecordingRow, StreamRow } from '../db/types.ts';
import { config } from '../config.ts';
import { ingestStatus } from '../ingest/status.ts';
import { activeRecordingId, isLive, liveProgress, recorderLog, THUMB_WIDTH } from '../ingest/recorder.ts';
import { clipPublicUrl, clipThumbnailUrl } from '../publish/index.ts';
import type { SpriteInfo } from '../media/render.ts';

export function streamDto(row: StreamRow) {
  return {
    id: row.id,
    name: row.name,
    streamKey: row.stream_key,
    autoRecord: Boolean(row.auto_record),
    createdAt: row.created_at,
    live: isLive(row.id),
    liveRecordingId: activeRecordingId(row.id) ?? null,
    ingest: {
      // null while no TCP proxy exists: the UI explains how to add one rather
      // than showing an address that cannot work.
      url: ingestStatus().endpoint?.url ?? null,
      key: row.stream_key,
    },
  };
}

export function recordingDto(row: RecordingRow, stream?: StreamRow) {
  return {
    id: row.id,
    streamId: row.stream_id,
    streamName: stream?.name ?? null,
    title: row.title,
    status: row.status,
    analysisStatus: row.analysis_status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    duration: row.duration,
    width: row.width,
    height: row.height,
    fps: row.fps,
    bytes: row.bytes,
    error: row.error,
    playbackUrl: playbackUrl(row),
    posterUrl: fs.existsSync(path.join(row.dir, 'poster.jpg')) ? `/media/recordings/${row.id}/poster.jpg` : null,
    sprite: readSprite(row),
    // While live, the browser plays the HLS output; how far along it is and
    // what ffmpeg has complained about are the only way to tell a stalled
    // recorder from a player problem.
    live:
      row.status === 'live'
        ? {
            ...liveProgress(row.dir),
            messages: recorderLog(row.id),
            // A filmstrip that grows with the broadcast, so the timeline is
            // navigable before the sprite sheet is built at the end.
            thumbInterval: config.thumbIntervalSeconds,
            thumbWidth: THUMB_WIDTH,
            baseUrl: `/media/recordings/${row.id}/`,
            // Same segments, presented as a finished recording, so scrubbing
            // back behaves like editing a file instead of chasing a live edge.
            archiveUrl: `/media/recordings/${row.id}/archive.m3u8`,
          }
        : null,
  };
}

/** While the encoder is connected the browser plays the growing HLS playlist. */
function playbackUrl(row: RecordingRow): string {
  const master = path.join(row.dir, 'master.mp4');
  if (row.status === 'ready' && fs.existsSync(master)) return `/media/recordings/${row.id}/master.mp4`;
  return `/media/recordings/${row.id}/index.m3u8`;
}

function readSprite(row: RecordingRow): (SpriteInfo & { baseUrl: string }) | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(row.dir, 'sprite.json'), 'utf8')) as SpriteInfo;
    return { ...info, baseUrl: `/media/recordings/${row.id}/` };
  } catch {
    return null;
  }
}

export function clipDto(row: ClipRow) {
  return {
    id: row.id,
    recordingId: row.recording_id,
    title: row.title,
    start: row.start_sec,
    end: row.end_sec,
    spec: JSON.parse(row.spec) as unknown,
    status: row.status,
    progress: row.progress,
    bytes: row.bytes,
    duration: row.duration,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fileUrl: row.status === 'ready' ? `/api/clips/${row.id}/file` : null,
    downloadUrl: row.status === 'ready' ? `/api/clips/${row.id}/download` : null,
    thumbUrl: row.thumb_path ? `/api/clips/${row.id}/thumb` : null,
    publicUrl: row.status === 'ready' ? clipPublicUrl(row) : null,
    publicThumbUrl: clipThumbnailUrl(row),
  };
}

export function publicationDto(row: PublicationRow) {
  return {
    id: row.id,
    clipId: row.clip_id,
    target: row.target,
    status: row.status,
    remoteId: row.remote_id,
    remoteUrl: row.remote_url,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function jobDto(row: JobRow) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
