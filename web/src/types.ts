export type RecordingStatus = 'live' | 'processing' | 'ready' | 'failed';
export type AnalysisStatus = 'pending' | 'running' | 'ready' | 'failed';
export type ClipStatus = 'queued' | 'rendering' | 'ready' | 'failed';
export type PublishTarget = 'youtube' | 'buffer' | 'webhook';
export type Aspect = '16:9' | '9:16' | '1:1' | '4:5';
export type FitMode = 'crop' | 'blur';

export interface Stream {
  id: string;
  name: string;
  streamKey: string;
  autoRecord: boolean;
  createdAt: number;
  live: boolean;
  liveRecordingId: string | null;
  ingest: { url: string; key: string };
}

export interface SpriteInfo {
  interval: number;
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  sheets: string[];
  count: number;
  baseUrl: string;
}

export interface Recording {
  id: string;
  streamId: string;
  streamName: string | null;
  title: string;
  status: RecordingStatus;
  analysisStatus: AnalysisStatus;
  startedAt: number;
  endedAt: number | null;
  duration: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  bytes: number;
  error: string | null;
  playbackUrl: string;
  posterUrl: string | null;
  sprite: SpriteInfo | null;
  clipCount?: number;
}

export interface RenderSpec {
  aspect: Aspect;
  fit: FitMode;
  focusX: number;
  focusY: number;
  resolution: number;
  mute: boolean;
  fadeIn: number;
  fadeOut: number;
  overlayText: string;
  overlayPosition: 'top' | 'bottom';
}

export interface Clip {
  id: string;
  recordingId: string;
  title: string;
  start: number;
  end: number;
  spec: RenderSpec;
  status: ClipStatus;
  progress: number;
  bytes: number | null;
  duration: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  fileUrl: string | null;
  downloadUrl: string | null;
  thumbUrl: string | null;
  publicUrl: string | null;
  publicThumbUrl: string | null;
}

export interface Publication {
  id: string;
  clipId: string;
  target: PublishTarget;
  status: 'queued' | 'uploading' | 'done' | 'failed';
  remoteId: string | null;
  remoteUrl: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Analysis {
  duration: number;
  interval: number;
  energy: number[];
  loudness: number[];
  motion: number[];
  scenes: number[];
  hasAudio: boolean;
  generatedAt: number;
}

export interface BufferProfile {
  id: string;
  service: string;
  username: string;
  avatar: string | null;
}

export interface Integrations {
  youtube: {
    configured: boolean;
    connected: boolean;
    channel: { id: string; title: string; thumbnail: string | null } | null;
    redirectUri: string;
  };
  buffer: { connected: boolean };
  webhook: { url: string | null; hasSecret: boolean };
}

export interface AppConfig {
  ingest: { url: string; host: string; port: number; app: string };
  publicUrl: string;
  maxRecordingHours: number;
}
