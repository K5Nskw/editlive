import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { config } from '../config.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('ffmpeg');

export interface RunOptions {
  /** Called for every stderr line; ffmpeg reports everything but -progress there. */
  onStderrLine?: (line: string) => void;
  /** Called for every stdout line (used with `-progress pipe:1` and metadata=print). */
  onStdoutLine?: (line: string) => void;
  /** Fractional progress 0..1, derived from `-progress pipe:1` when totalSeconds is known. */
  onProgress?: (fraction: number) => void;
  totalSeconds?: number;
  signal?: AbortSignal;
  /** Keep this many stderr lines for the error message. */
  tailLines?: number;
}

export class FfmpegError extends Error {
  readonly code: number | null;
  readonly tail: string;

  constructor(message: string, code: number | null, tail: string) {
    super(message);
    this.name = 'FfmpegError';
    this.code = code;
    this.tail = tail;
  }
}

function lineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  rl.on('line', onLine);
  return rl;
}

/** Run ffmpeg to completion, rejecting with the tail of stderr on a non-zero exit. */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<void> {
  return runBinary(config.ffmpegPath, args, opts);
}

export function runBinary(bin: string, args: string[], opts: RunOptions = {}): Promise<void> {
  const tailLimit = opts.tailLines ?? 20;
  return new Promise((resolve, reject) => {
    log.debug(`${bin} ${args.join(' ')}`);
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const tail: string[] = [];
    let settled = false;

    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    lineReader(child.stderr, (line) => {
      tail.push(line);
      if (tail.length > tailLimit) tail.shift();
      opts.onStderrLine?.(line);
    });

    lineReader(child.stdout, (line) => {
      opts.onStdoutLine?.(line);
      if (opts.onProgress && opts.totalSeconds && line.startsWith('out_time_us=')) {
        const us = Number(line.slice('out_time_us='.length));
        if (Number.isFinite(us) && us >= 0) {
          opts.onProgress(Math.max(0, Math.min(1, us / 1e6 / opts.totalSeconds)));
        }
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new FfmpegError(`${bin} exited with code ${code}`, code, tail.join('\n')));
    });
  });
}

export interface ProbeResult {
  duration: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  bitrate: number | null;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  duration?: string;
}

function parseFps(rate: string | undefined): number | null {
  if (!rate) return null;
  const [num, den] = rate.split('/').map(Number);
  if (!num || !den) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null;
}

/** ffprobe a file (or an HLS playlist) into the few fields the app cares about. */
export async function probe(input: string): Promise<ProbeResult> {
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input];
  let stdout = '';
  await runBinary(config.ffprobePath, args, { onStdoutLine: (l) => (stdout += l) });
  const parsed = JSON.parse(stdout || '{}') as {
    format?: { duration?: string; bit_rate?: string };
    streams?: FfprobeStream[];
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(parsed.format?.duration ?? video?.duration ?? 0);
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseFps(video?.avg_frame_rate),
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
    bitrate: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : null,
  };
}

export interface LongRunningProcess {
  child: ChildProcessWithoutNullStreams;
  /** Ask ffmpeg to finish cleanly (writes 'q' to stdin), then SIGKILL after a grace period. */
  stop: (graceMs?: number) => Promise<number | null>;
  exited: Promise<number | null>;
}

/**
 * Spawn an ffmpeg that is expected to run until the input ends (the recorder).
 * stdin stays open so the process can be stopped gracefully and finalise its files.
 */
export function spawnFfmpeg(args: string[], onLine?: (line: string) => void): LongRunningProcess {
  log.debug(`spawn ${config.ffmpegPath} ${args.join(' ')}`);
  const child = spawn(config.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  if (onLine) {
    lineReader(child.stderr, onLine);
    lineReader(child.stdout, onLine);
  } else {
    child.stderr.resume();
    child.stdout.resume();
  }

  const exited = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));

  async function stop(graceMs = 8000): Promise<number | null> {
    if (child.exitCode !== null || child.signalCode !== null) return exited;
    try {
      child.stdin.write('q');
      child.stdin.end();
    } catch {
      /* stdin already gone */
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    const code = await exited;
    clearTimeout(timer);
    return code;
  }

  return { child, stop, exited };
}
