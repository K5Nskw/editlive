import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { probe, runFfmpeg } from './ffmpeg.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('render');

export const ASPECTS = ['16:9', '9:16', '1:1', '4:5'] as const;
export type Aspect = (typeof ASPECTS)[number];

export const FIT_MODES = ['crop', 'blur'] as const;
export type FitMode = (typeof FIT_MODES)[number];

export interface RenderSpec {
  aspect: Aspect;
  /** `crop` zooms in on the focus point; `blur` fits the frame over a blurred fill. */
  fit: FitMode;
  focusX: number;
  focusY: number;
  /** Short side of the output in pixels. */
  resolution: number;
  mute: boolean;
  fadeIn: number;
  fadeOut: number;
  overlayText: string;
  overlayPosition: 'top' | 'bottom';
}

export const DEFAULT_SPEC: RenderSpec = {
  aspect: '9:16',
  fit: 'blur',
  focusX: 0.5,
  focusY: 0.5,
  resolution: 1080,
  mute: false,
  // A clip is a cut out of a broadcast, not a standalone film: opening on
  // black hides the moment it was made for. Still honoured when asked for.
  fadeIn: 0,
  fadeOut: 0,
  overlayText: '',
  overlayPosition: 'bottom',
};

function even(n: number): number {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r + 1;
}

export function outputSize(aspect: Aspect, shortSide: number): { width: number; height: number } {
  const [aw, ah] = aspect.split(':').map(Number) as [number, number];
  const ratio = aw / ah;
  return ratio >= 1
    ? { width: even(shortSide * ratio), height: even(shortSide) }
    : { width: even(shortSide), height: even(shortSide / ratio) };
}

/** Escape a value used inside an ffmpeg filter option (`:` and `\` are special). */
function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function buildVideoChain(spec: RenderSpec, duration: number, textFile: string | undefined): string {
  const { width, height } = outputSize(spec.aspect, spec.resolution);
  const focusX = Math.min(1, Math.max(0, spec.focusX));
  const focusY = Math.min(1, Math.max(0, spec.focusY));
  const parts: string[] = [];

  if (spec.fit === 'crop') {
    parts.push(
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height}:(iw-${width})*${focusX}:(ih-${height})*${focusY},setsar=1[v0]`,
    );
  } else {
    parts.push(
      `[0:v]split=2[bg][fg]`,
      `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
        `gblur=sigma=28,eq=brightness=-0.12:saturation=1.1,setsar=1[bgb]`,
      `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease,setsar=1[fgs]`,
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2[v0]`,
    );
  }

  const post: string[] = [];
  if (spec.fadeIn > 0) post.push(`fade=t=in:st=0:d=${spec.fadeIn.toFixed(2)}`);
  if (spec.fadeOut > 0 && duration > spec.fadeOut) {
    post.push(`fade=t=out:st=${(duration - spec.fadeOut).toFixed(2)}:d=${spec.fadeOut.toFixed(2)}`);
  }
  if (textFile) {
    const y = spec.overlayPosition === 'top' ? 'h*0.07' : 'h-text_h-h*0.09';
    post.push(
      [
        'drawtext',
        `=fontfile='${escapeFilterValue(config.fontFile)}'`,
        `:textfile='${escapeFilterValue(textFile)}'`,
        ':fontcolor=white',
        `:fontsize=h/22`,
        ':line_spacing=8',
        ':box=1:boxcolor=black@0.45:boxborderw=24',
        ':x=(w-text_w)/2',
        `:y=${y}`,
      ].join(''),
    );
  }
  post.push('format=yuv420p');

  parts.push(`[v0]${post.join(',')}[vout]`);
  return parts.join(';');
}

function buildAudioChain(spec: RenderSpec, duration: number): string | undefined {
  const filters: string[] = [];
  if (spec.fadeIn > 0) filters.push(`afade=t=in:st=0:d=${spec.fadeIn.toFixed(2)}`);
  if (spec.fadeOut > 0 && duration > spec.fadeOut) {
    filters.push(`afade=t=out:st=${(duration - spec.fadeOut).toFixed(2)}:d=${spec.fadeOut.toFixed(2)}`);
  }
  return filters.length > 0 ? `[0:a]${filters.join(',')}[aout]` : undefined;
}

export interface RenderClipOptions {
  source: string;
  start: number;
  end: number;
  spec: RenderSpec;
  outFile: string;
  hasAudio: boolean;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export async function renderClip(opts: RenderClipOptions): Promise<{ duration: number; bytes: number }> {
  const duration = Math.max(0.5, opts.end - opts.start);
  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });

  let textFile: string | undefined;
  const text = opts.spec.overlayText.trim();
  if (text) {
    if (fs.existsSync(config.fontFile)) {
      fs.mkdirSync(config.tmpDir, { recursive: true });
      textFile = path.join(config.tmpDir, `${path.basename(opts.outFile, '.mp4')}.txt`);
      fs.writeFileSync(textFile, text);
    } else {
      log.warn(`font ${config.fontFile} not found, skipping the text overlay`);
    }
  }

  const useAudio = opts.hasAudio && !opts.spec.mute;
  const audioChain = useAudio ? buildAudioChain(opts.spec, duration) : undefined;
  const filterComplex = [buildVideoChain(opts.spec, duration, textFile), audioChain].filter(Boolean).join(';');

  const args = [
    '-hide_banner', '-nostdin', '-v', 'error', '-y',
    '-ss', opts.start.toFixed(3),
    '-i', opts.source,
    '-t', duration.toFixed(3),
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    ...(useAudio ? ['-map', audioChain ? '[aout]' : '0:a'] : ['-an']),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '21',
    '-profile:v', 'high',
    '-level', '4.1',
    '-g', '60',
    ...(useAudio ? ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'] : []),
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    opts.outFile,
  ];

  try {
    await runFfmpeg(args, {
      signal: opts.signal,
      totalSeconds: duration,
      onProgress: opts.onProgress,
      tailLines: 30,
    });
  } finally {
    if (textFile) fs.rmSync(textFile, { force: true });
  }

  const info = await probe(opts.outFile);
  return { duration: info.duration, bytes: fs.statSync(opts.outFile).size };
}

export async function extractThumbnail(source: string, at: number, outFile: string, width = 640): Promise<void> {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await runFfmpeg([
    '-hide_banner', '-nostdin', '-v', 'error', '-y',
    '-ss', Math.max(0, at).toFixed(2),
    '-i', source,
    '-frames:v', '1',
    '-vf', `scale=${width}:-2`,
    '-qscale:v', '4',
    outFile,
  ]);
}

export interface SpriteInfo {
  interval: number;
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  sheets: string[];
  count: number;
}

/**
 * A grid of thumbnails per sheet keeps the editor timeline to a couple of
 * requests instead of one per frame.
 */
export async function generateSprite(
  source: string,
  dir: string,
  duration: number,
  size: { width: number | null; height: number | null },
): Promise<SpriteInfo> {
  const interval = Math.max(2, config.thumbIntervalSeconds);
  const cols = 10;
  const rows = 10;
  const tileWidth = 160;
  const ratio = size.width && size.height ? size.height / size.width : 9 / 16;
  const tileHeight = even(tileWidth * ratio);

  await runFfmpeg([
    '-hide_banner', '-nostdin', '-v', 'error', '-y',
    '-i', source,
    '-an',
    '-vf', `fps=1/${interval},scale=${tileWidth}:${tileHeight},tile=${cols}x${rows}`,
    '-qscale:v', '6',
    '-start_number', '0',
    path.join(dir, 'sprite_%02d.jpg'),
  ]);

  const sheets = fs
    .readdirSync(dir)
    .filter((f) => /^sprite_\d+\.jpg$/.test(f))
    .sort();

  return {
    interval,
    cols,
    rows,
    tileWidth,
    tileHeight,
    sheets,
    count: Math.ceil(duration / interval),
  };
}
