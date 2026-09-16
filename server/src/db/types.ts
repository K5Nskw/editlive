export type RecordingStatus = 'live' | 'processing' | 'ready' | 'failed';
export type AnalysisStatus = 'pending' | 'running' | 'ready' | 'failed';
export type ClipStatus = 'queued' | 'rendering' | 'ready' | 'failed';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type JobType = 'postprocess' | 'analyze' | 'render' | 'publish';
export type PublishTarget = 'youtube' | 'buffer' | 'webhook';
export type PublishStatus = 'queued' | 'uploading' | 'done' | 'failed';

export interface StreamRow {
  id: string;
  name: string;
  stream_key: string;
  auto_record: number;
  created_at: number;
}

export interface RecordingRow {
  id: string;
  stream_id: string;
  title: string;
  status: RecordingStatus;
  analysis_status: AnalysisStatus;
  started_at: number;
  ended_at: number | null;
  duration: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  bytes: number;
  dir: string;
  error: string | null;
}

export interface ClipRow {
  id: string;
  recording_id: string | null;
  source_title: string | null;
  title: string;
  start_sec: number;
  end_sec: number;
  spec: string;
  status: ClipStatus;
  progress: number;
  file_path: string | null;
  thumb_path: string | null;
  bytes: number | null;
  duration: number | null;
  public_token: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface JobRow {
  id: string;
  type: JobType;
  payload: string;
  status: JobStatus;
  attempts: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface PublicationRow {
  id: string;
  clip_id: string;
  target: PublishTarget;
  status: PublishStatus;
  options: string;
  remote_id: string | null;
  remote_url: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}
