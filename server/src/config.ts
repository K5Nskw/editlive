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

// Railway sets RAILWAY_VOLUME_MOUNT_PATH once a volume is attached, so a
// deployment persists its recordings without anyone setting DATA_DIR by hand.
const dataDir = path.resolve(
  env('DATA_DIR') ?? env('RAILWAY_VOLUME_MOUNT_PATH') ?? path.join(process.cwd(), 'data'),
);

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

const publicUrl = (
  env('PUBLIC_URL') ??
  env('RAILWAY_PUBLIC_DOMAIN_URL') ??
  (env('RAILWAY_PUBLIC_DOMAIN') ? `https://${env('RAILWAY_PUBLIC_DOMAIN')}` : undefined) ??
  `http://localhost:${envInt('PORT', 3000)}`
).replace(/\/+$/, '');

const servedLocally = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(publicUrl);

const httpPort = envInt('PORT', 3000);

// Railway's TCP proxy names the container port it forwards to, so the RTMP
// listener follows whatever port the proxy was pointed at — unless that is the
// port the web server needs. The UI must never lose its port to ingest.
const requestedRtmpPort = envInt('RTMP_PORT', envInt('RAILWAY_TCP_APPLICATION_PORT', 1935));
const rtmpPortConflict = requestedRtmpPort === httpPort;
const rtmpPort = rtmpPortConflict ? (httpPort === 1935 ? 1936 : 1935) : requestedRtmpPort;

/**
 * The address an encoder publishes to. It is only knowable from a TCP proxy (or
 * an explicit override): the HTTP domain terminates TLS and cannot carry RTMP,
 * so printing it would send operators to an endpoint that silently fails.
 * Null means "no ingest endpoint is reachable from outside yet".
 */
const rtmpPublicHost = env('RTMP_PUBLIC_HOST') ?? env('RAILWAY_TCP_PROXY_DOMAIN') ?? (servedLocally ? 'localhost' : null);

export const config = {
  port: httpPort,
  rtmpPort,
  /** True when a TCP proxy points at the web server's port instead of a free one. */
  rtmpPortConflict,
  requestedRtmpPort,
  rtmpApp: env('RTMP_APP') ?? 'live',

  dataDir,
  recordingsDir: path.join(dataDir, 'recordings'),
  clipsDir: path.join(dataDir, 'clips'),
  tmpDir: path.join(dataDir, 'tmp'),

  /** Absolute base URL of this deployment, used for share links and OAuth redirects. */
  publicUrl,

  /** Host/port an encoder such as OBS publishes to; null until a TCP proxy exists. */
  rtmpPublicHost,
  rtmpPublicPort: envInt('RTMP_PUBLIC_PORT', Number(env('RAILWAY_TCP_PROXY_PORT') ?? rtmpPort)),

  appPassword: env('APP_PASSWORD') ?? generatedPassword!,
  generatedPassword,
  sessionSecret: persistentSecret('.session-secret', 'SESSION_SECRET'),
  sessionTtlMs: envInt('SESSION_TTL_HOURS', 24 * 14) * 3600_000,

  ffmpegPath: env('FFMPEG_PATH') ?? 'ffmpeg',
  ffprobePath: env('FFPROBE_PATH') ?? 'ffprobe',
  fontFile: env('FONT_FILE') ?? resolveFont(),

  /** Serial by default: ffmpeg renders are CPU bound and Railway containers are small. */
  jobConcurrency: envInt('JOB_CONCURRENCY', 1),
  hlsSegmentSeconds: envInt('HLS_SEGMENT_SECONDS', 2),
  /**
   * Re-encode the live preview instead of copying the incoming stream. ffmpeg
   * can only cut an HLS segment at a keyframe, so a copied preview is at the
   * mercy of the encoder's keyframe interval — long ones delay playback, and
   * very long ones produce no playable segment at all. Encoding lets the
   * segments be cut on our terms. Set LIVE_PREVIEW=copy to save the CPU when
   * the encoder is known to send frequent keyframes.
   */
  livePreviewEncode: (env('LIVE_PREVIEW') ?? 'encode') !== 'copy',
  livePreviewHeight: envInt('LIVE_PREVIEW_HEIGHT', 480),
  livePreviewBitrate: env('LIVE_PREVIEW_BITRATE') ?? '1200k',
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

  /** True on Railway with no volume attached: everything written is lost on redeploy. */
  storageIsEphemeral: Boolean(env('RAILWAY_ENVIRONMENT_NAME') ?? env('RAILWAY_ENVIRONMENT')) &&
    !env('RAILWAY_VOLUME_MOUNT_PATH') && !env('DATA_DIR'),
} as const;

export type Config = typeof config;
