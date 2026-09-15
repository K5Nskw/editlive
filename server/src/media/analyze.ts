import fs from 'node:fs';
import path from 'node:path';
import { probe, runFfmpeg } from './ffmpeg.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('analyze');

export interface AnalysisResult {
  duration: number;
  /** Seconds covered by one entry of `energy` / `loudness` / `motion`. */
  interval: number;
  /** Combined loudness/motion curve, 0..1, one entry per interval. */
  energy: number[];
  /** RMS level in dBFS per interval (-70 when silent or absent). */
  loudness: number[];
  /** Mean frame-difference score per interval, 0..1. */
  motion: number[];
  /** Timestamps (seconds) of detected shot changes. */
  scenes: number[];
  hasAudio: boolean;
  generatedAt: number;
}

const SILENT_DB = -70;
const CUT_THRESHOLD = 0.35;
const SAMPLE_FPS = 5;

const PTS_LINE = /pts_time:(\d+(?:\.\d+)?)/;
const SCENE_LINE = /lavfi\.scene_score=(\d+(?:\.\d+)?)/;
const RMS_LINE = /lavfi\.astats\.Overall\.RMS_level=(-?\d+(?:\.\d+)?|-?inf|nan)/i;

function emptyBuckets(count: number, fill: number): number[] {
  return new Array<number>(Math.max(count, 0)).fill(fill);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx]!;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * RMS level in dBFS per interval. `asetnsamples` cuts the audio into
 * one-interval frames and `astats` is reset per frame, so every printed value
 * covers exactly one bucket — unlike ebur128's frame log, which only appears
 * at some log levels and ffmpeg versions.
 */
async function measureLoudness(source: string, buckets: number, interval: number, signal?: AbortSignal): Promise<number[]> {
  const loudness = emptyBuckets(buckets, SILENT_DB);
  const samplesPerFrame = Math.round(48000 * interval);
  let pendingTime: number | null = null;

  await runFfmpeg(
    [
      '-hide_banner', '-nostdin', '-v', 'error',
      '-i', source,
      '-vn',
      '-af',
      `aresample=48000,asetnsamples=n=${samplesPerFrame}:p=0,astats=metadata=1:reset=1,` +
        'ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
      '-f', 'null', '-',
    ],
    {
      signal,
      tailLines: 30,
      onStdoutLine: (line) => {
        const pts = PTS_LINE.exec(line);
        if (pts) {
          pendingTime = Number(pts[1]);
          return;
        }
        const rms = RMS_LINE.exec(line);
        if (!rms || pendingTime === null) return;
        const raw = rms[1]!.toLowerCase();
        const value = raw.includes('inf') || raw === 'nan' ? SILENT_DB : Math.max(SILENT_DB, Number(raw));
        const idx = Math.floor(pendingTime / interval);
        if (idx >= 0 && idx < loudness.length && value > loudness[idx]!) loudness[idx] = value;
        pendingTime = null;
      },
    },
  );
  return loudness;
}

/**
 * Frame-difference score per second plus shot-change timestamps, from a single
 * decode pass at reduced resolution and frame rate.
 */
async function measureMotion(
  source: string,
  buckets: number,
  interval: number,
  signal?: AbortSignal,
): Promise<{ motion: number[]; scenes: number[] }> {
  const sums = emptyBuckets(buckets, 0);
  const counts = emptyBuckets(buckets, 0);
  const scenes: number[] = [];
  let pendingTime: number | null = null;

  await runFfmpeg(
    [
      '-hide_banner',
      '-nostdin',
      '-v', 'error',
      '-i', source,
      '-an',
      '-vf', `fps=${SAMPLE_FPS},scale=320:-2,select='gte(scene\\,0)',metadata=print:file=-`,
      '-f', 'null',
      '-',
    ],
    {
      signal,
      tailLines: 30,
      onStdoutLine: (line) => {
        const pts = PTS_LINE.exec(line);
        if (pts) {
          pendingTime = Number(pts[1]);
          return;
        }
        const scene = SCENE_LINE.exec(line);
        if (!scene || pendingTime === null) return;
        const score = Number(scene[1]);
        const idx = Math.floor(pendingTime / interval);
        if (idx >= 0 && idx < sums.length) {
          sums[idx] = sums[idx]! + score;
          counts[idx] = counts[idx]! + 1;
        }
        if (score >= CUT_THRESHOLD) scenes.push(Math.round(pendingTime * 100) / 100);
        pendingTime = null;
      },
    },
  );

  const motion = sums.map((sum, i) => (counts[i]! > 0 ? sum / counts[i]! : 0));
  return { motion, scenes };
}

/**
 * Turn raw measurements into a 0..1 excitement curve for the editing timeline.
 * Loudness is judged against the recording's own baseline, so a quiet studio
 * feed and a loud arena feed produce comparable curves.
 */
export function buildEnergy(loudness: number[], motion: number[], hasAudio: boolean): number[] {
  const audible = loudness.filter((v) => v > SILENT_DB + 1);
  const audioBase = audible.length > 0 ? percentile(audible, 0.5) : SILENT_DB;
  const audioPeak = audible.length > 0 ? percentile(audible, 0.98) : SILENT_DB + 1;
  const audioRange = Math.max(3, audioPeak - audioBase);

  const motionBase = percentile(motion, 0.5);
  const motionPeak = percentile(motion, 0.98);
  const motionRange = Math.max(0.01, motionPeak - motionBase);

  return loudness.map((loud, i) => {
    const a = hasAudio ? clamp01((loud - audioBase) / audioRange) : 0;
    const m = clamp01((motion[i]! - motionBase) / motionRange);
    return hasAudio ? 0.72 * a + 0.28 * m : m;
  });
}

/** Decode the recording once for audio and once for video, at low resolution. */
export async function analyzeSource(source: string, signal?: AbortSignal): Promise<AnalysisResult> {
  const info = await probe(source);
  const duration = info.duration;
  if (!(duration > 0)) throw new Error('cannot analyse a source with unknown duration');

  const interval = 1;
  const buckets = Math.ceil(duration / interval);

  const loudness = info.hasAudio
    ? await measureLoudness(source, buckets, interval, signal)
    : emptyBuckets(buckets, SILENT_DB);
  const { motion, scenes } = await measureMotion(source, buckets, interval, signal);

  const energy = buildEnergy(loudness, motion, info.hasAudio);
  log.info(`analysed ${path.basename(source)}: ${duration.toFixed(1)}s, ${scenes.length} cuts, audio=${info.hasAudio}`);

  return {
    duration,
    interval,
    energy: energy.map((v) => Math.round(v * 1000) / 1000),
    loudness: loudness.map((v) => Math.round(v * 10) / 10),
    motion: motion.map((v) => Math.round(v * 1000) / 1000),
    scenes,
    hasAudio: info.hasAudio,
    generatedAt: Date.now(),
  };
}

export function writeAnalysis(dir: string, analysis: AnalysisResult): void {
  fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(analysis));
}

export function readAnalysis(dir: string): AnalysisResult | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'analysis.json'), 'utf8')) as AnalysisResult;
  } catch {
    return undefined;
  }
}
