import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function envInt(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const dataDir = path.resolve(env('DATA_DIR') ?? path.join(process.cwd(), 'data'));

/** Generated secrets are persisted so sessions survive a restart on a volume. */
function persistentSecret(file: string, envName: string): string {
  const fromEnv = env(envName);
  if (fromEnv) return fromEnv;
  const p = path.join(dataDir, file);
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(p, secret, { mode: 0o600 });
    return secret;
  }
}

fs.mkdirSync(dataDir, { recursive: true });

/**
 * Overlay text is usually Japanese, so prefer a CJK face and only fall back to
 * a Latin one. FONT_FILE overrides the search.
 */
function resolveFont(): string {
  const candidates = [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/fonts-japanese-gothic.ttf',
    '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[candidates.length - 1]!;
}

const generatedPassword = env('APP_PASSWORD') ? undefined : crypto.randomBytes(9).toString('base64url');

export const config = {
  port: envInt('PORT', 3000),
  rtmpPort: envInt('RTMP_PORT', 1935),
  rtmpApp: env('RTMP_APP') ?? 'live',

  dataDir,
  recordingsDir: path.join(dataDir, 'recordings'),
  clipsDir: path.join(dataDir, 'clips'),
  tmpDir: path.join(dataDir, 'tmp'),

  /** Absolute base URL of this deployment, used for share links and OAuth redirects. */
  publicUrl: (env('PUBLIC_URL') ?? env('RAILWAY_PUBLIC_DOMAIN_URL') ??
    (env('RAILWAY_PUBLIC_DOMAIN') ? `https://${env('RAILWAY_PUBLIC_DOMAIN')}` : undefined) ??
    `http://localhost:${envInt('PORT', 3000)}`).replace(/\/+$/, ''),

  /** Host/port an encoder such as OBS should publish to (Railway TCP proxy). */
  rtmpPublicHost: env('RTMP_PUBLIC_HOST') ?? env('RAILWAY_TCP_PROXY_DOMAIN') ?? 'localhost',
  rtmpPublicPort: envInt('RTMP_PUBLIC_PORT', Number(env('RAILWAY_TCP_PROXY_PORT') ?? envInt('RTMP_PORT', 1935))),

  appPassword: env('APP_PASSWORD') ?? generatedPassword!,
  generatedPassword,
  sessionSecret: persistentSecret('.session-secret', 'SESSION_SECRET'),
  sessionTtlMs: envInt('SESSION_TTL_HOURS', 24 * 14) * 3600_000,

  ffmpegPath: env('FFMPEG_PATH') ?? 'ffmpeg',
  ffprobePath: env('FFPROBE_PATH') ?? 'ffprobe',
  fontFile: env('FONT_FILE') ?? resolveFont(),

  /** Serial by default: ffmpeg renders are CPU bound and Railway containers are small. */
  jobConcurrency: envInt('JOB_CONCURRENCY', 1),
  hlsSegmentSeconds: envInt('HLS_SEGMENT_SECONDS', 4),
  /** Safety valve so a forgotten encoder cannot fill the volume. */
  maxRecordingSeconds: envInt('MAX_RECORDING_HOURS', 6) * 3600,
  thumbIntervalSeconds: envInt('THUMB_INTERVAL_SECONDS', 10),

  google: {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
  },
  bufferToken: env('BUFFER_ACCESS_TOKEN'),

  trustProxy: envBool('TRUST_PROXY', true),
  isProduction: (env('NODE_ENV') ?? 'development') === 'production',
} as const;

export type Config = typeof config;
