import fs from 'node:fs';
import path from 'node:path';
import { probe, runFfmpeg } from './ffmpeg.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('analyze');

export interface AnalysisResult {
  duration: number;
  /** Seconds covered by one entry of `energy` / `loudness` / `motion`. */
  interval: number;
  /** Combined excitement curve, 0..1, one entry per interval. */
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

export interface HighlightCandidate {
  start: number;
  end: number;
  peak: number;
  score: number;
  reason: string;
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

function movingAverage(values: number[], window: number): number[] {
  if (window <= 1) return [...values];
  const half = Math.floor(window / 2);
  const out = new Array<number>(values.length).fill(0);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = i - half; j <= i + half; j++) {
      const v = values[j];
      if (v === undefined) continue;
      sum += v;
      n += 1;
    }
    out[i] = n > 0 ? sum / n : 0;
  }
  return out;
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
 * Turn raw measurements into a 0..1 excitement curve. Loudness is judged
 * against the recording's own baseline, so a quiet studio feed and a loud
 * arena feed produce comparable curves.
 */
function buildEnergy(loudness: number[], motion: number[], hasAudio: boolean): number[] {
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

function describe(loudDelta: number, motionDelta: number, cuts: number): string {
  if (cuts >= 3 && loudDelta > 0.3) return '歓声とカット割りが集中';
  if (loudDelta > 0.55) return '音量が大きく跳ね上がった';
  if (motionDelta > 0.55) return '画面の動きが激しい';
  if (cuts >= 3) return 'カットが立て込んでいる';
  return '平常時より盛り上がっている';
}

export interface DetectOptions {
  /** 0..1; higher yields more (and looser) candidates. */
  sensitivity?: number;
  maxCandidates?: number;
  minClipSeconds?: number;
  maxClipSeconds?: number;
}

/** Pick peak-centred windows out of the excitement curve. */
export function detectHighlights(analysis: AnalysisResult, opts: DetectOptions = {}): HighlightCandidate[] {
  const sensitivity = clamp01(opts.sensitivity ?? 0.5);
  const maxCandidates = opts.maxCandidates ?? 20;
  const minClip = opts.minClipSeconds ?? 8;
  const maxClip = opts.maxClipSeconds ?? 60;
  const { interval, duration } = analysis;

  const smooth = movingAverage(analysis.energy, Math.max(3, Math.round(3 / interval)));
  if (smooth.length === 0) return [];

  const mean = smooth.reduce((a, b) => a + b, 0) / smooth.length;
  const variance = smooth.reduce((acc, v) => acc + (v - mean) ** 2, 0) / smooth.length;
  const std = Math.sqrt(variance);
  const k = 1.9 - 1.4 * sensitivity;
  const threshold = Math.max(0.1, mean + k * std);

  const minGap = Math.round((22 - 10 * sensitivity) / interval);
  const peaks: Array<{ idx: number; value: number }> = [];
  for (let i = 0; i < smooth.length; i++) {
    const value = smooth[i]!;
    if (value < threshold) continue;
    let isPeak = true;
    for (let j = Math.max(0, i - minGap); j <= Math.min(smooth.length - 1, i + minGap); j++) {
      if (smooth[j]! > value) {
        isPeak = false;
        break;
      }
    }
    if (isPeak && !peaks.some((p) => Math.abs(p.idx - i) < minGap)) peaks.push({ idx: i, value });
  }

  peaks.sort((a, b) => b.value - a.value);
  const top = peaks.slice(0, maxCandidates);
  const maxValue = top[0]?.value ?? 1;

  const candidates: HighlightCandidate[] = top.map(({ idx, value }) => {
    const onsetFloor = value * 0.5;
    const tailFloor = value * 0.4;
    let startIdx = idx;
    while (startIdx > 0 && smooth[startIdx - 1]! > onsetFloor && (idx - startIdx) * interval < 20) startIdx -= 1;
    let endIdx = idx;
    while (endIdx < smooth.length - 1 && smooth[endIdx + 1]! > tailFloor && (endIdx - idx) * interval < 15) endIdx += 1;

    // A highlight is the build-up plus the reaction, so pad both sides.
    let start = Math.max(0, startIdx * interval - 3);
    let end = Math.min(duration, (endIdx + 1) * interval + 2.5);
    if (end - start < minClip) {
      const pad = (minClip - (end - start)) / 2;
      start = Math.max(0, start - pad);
      end = Math.min(duration, start + minClip);
    }
    if (end - start > maxClip) end = start + maxClip;

    const peakTime = idx * interval;
    const window = analysis.energy.slice(startIdx, endIdx + 1);
    const loudDelta = clamp01(Math.max(...window, 0));
    const motionDelta = clamp01(Math.max(...analysis.motion.slice(startIdx, endIdx + 1), 0));
    const cuts = analysis.scenes.filter((t) => t >= start && t <= end).length;

    return {
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      peak: Math.round(peakTime * 100) / 100,
      score: Math.round((maxValue > 0 ? value / maxValue : 0) * 1000) / 1000,
      reason: describe(loudDelta, motionDelta, cuts),
    };
  });

  // Peaks are found on a minimum-gap grid but padding can still overlap them.
  candidates.sort((a, b) => a.start - b.start);
  const merged: HighlightCandidate[] = [];
  for (const cand of candidates) {
    const prev = merged[merged.length - 1];
    if (prev && cand.start < prev.end) {
      if (cand.score > prev.score) {
        prev.end = Math.min(Math.max(prev.end, cand.end), prev.start + maxClip);
        prev.score = cand.score;
        prev.peak = cand.peak;
        prev.reason = cand.reason;
      } else {
        prev.end = Math.min(Math.max(prev.end, cand.end), prev.start + maxClip);
      }
      continue;
    }
    merged.push({ ...cand });
  }

  return merged.sort((a, b) => b.score - a.score);
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
