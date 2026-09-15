import fs from 'node:fs';
import path from 'node:path';
import type { ClipRow, JobRow, PublicationRow, RecordingRow, StreamRow } from '../db/types.ts';
import { config } from '../config.ts';
import { isLive, activeRecordingId } from '../ingest/recorder.ts';
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
      url: `rtmp://${config.rtmpPublicHost}:${config.rtmpPublicPort}/${config.rtmpApp}`,
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
