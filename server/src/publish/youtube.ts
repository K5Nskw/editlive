import fs from 'node:fs';
import { google } from 'googleapis';
import type { Credentials, OAuth2Client } from 'google-auth-library';
import { config } from '../config.ts';
import { deleteSetting, getJson, setJson } from '../db/index.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('youtube');

const TOKENS_KEY = 'youtube.tokens';
const CHANNEL_KEY = 'youtube.channel';

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

export function redirectUri(): string {
  return `${config.publicUrl}/api/integrations/youtube/callback`;
}

export function isConfigured(): boolean {
  return Boolean(config.google.clientId && config.google.clientSecret);
}

function client(): OAuth2Client {
  if (!isConfigured()) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set on this deployment');
  }
  const oauth = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, redirectUri());
  // Refreshes happen transparently; persist them so the connection survives restarts.
  oauth.on('tokens', (tokens) => {
    const stored = getJson<Credentials>(TOKENS_KEY) ?? {};
    setJson(TOKENS_KEY, { ...stored, ...tokens, refresh_token: tokens.refresh_token ?? stored.refresh_token });
  });
  return oauth;
}

function authorizedClient(): OAuth2Client {
  const tokens = getJson<Credentials>(TOKENS_KEY);
  if (!tokens?.refresh_token && !tokens?.access_token) {
    throw new Error('YouTube is not connected yet — connect it from the settings page');
  }
  const oauth = client();
  oauth.setCredentials(tokens);
  return oauth;
}

export function authUrl(state: string): string {
  return client().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: YOUTUBE_SCOPES,
    include_granted_scopes: true,
    state,
  });
}

export interface ChannelInfo {
  id: string;
  title: string;
  thumbnail: string | null;
}

export async function completeAuth(code: string): Promise<ChannelInfo | null> {
  const oauth = client();
  const { tokens } = await oauth.getToken(code);
  setJson(TOKENS_KEY, tokens);
  oauth.setCredentials(tokens);
  const channel = await fetchChannel(oauth);
  if (channel) setJson(CHANNEL_KEY, channel);
  return channel;
}

async function fetchChannel(auth: OAuth2Client): Promise<ChannelInfo | null> {
  try {
    const youtube = google.youtube({ version: 'v3', auth });
    const res = await youtube.channels.list({ part: ['snippet'], mine: true });
    const item = res.data.items?.[0];
    if (!item?.id) return null;
    return {
      id: item.id,
      title: item.snippet?.title ?? item.id,
      thumbnail: item.snippet?.thumbnails?.default?.url ?? null,
    };
  } catch (err) {
    log.warn('could not read the connected channel', err);
    return null;
  }
}

export function connectionStatus(): { configured: boolean; connected: boolean; channel: ChannelInfo | null } {
  return {
    configured: isConfigured(),
    connected: Boolean(getJson<Credentials>(TOKENS_KEY)),
    channel: getJson<ChannelInfo>(CHANNEL_KEY) ?? null,
  };
}

export function disconnect(): void {
  deleteSetting(TOKENS_KEY);
  deleteSetting(CHANNEL_KEY);
}

export interface YoutubeUploadOptions {
  file: string;
  title: string;
  description?: string;
  tags?: string[];
  privacyStatus?: 'private' | 'unlisted' | 'public';
  madeForKids?: boolean;
  onProgress?: (fraction: number) => void;
}

export async function uploadVideo(opts: YoutubeUploadOptions): Promise<{ id: string; url: string }> {
  const auth = authorizedClient();
  const youtube = google.youtube({ version: 'v3', auth });
  const total = fs.statSync(opts.file).size;

  const res = await youtube.videos.insert(
    {
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: opts.title.slice(0, 100),
          description: (opts.description ?? '').slice(0, 5000),
          tags: opts.tags?.slice(0, 30),
        },
        status: {
          privacyStatus: opts.privacyStatus ?? 'unlisted',
          selfDeclaredMadeForKids: opts.madeForKids ?? false,
        },
      },
      media: { body: fs.createReadStream(opts.file) },
    },
    {
      onUploadProgress: (event: { bytesRead: number }) => {
        if (total > 0) opts.onProgress?.(Math.min(1, event.bytesRead / total));
      },
    },
  );

  const id = res.data.id;
  if (!id) throw new Error('YouTube did not return a video id');
  return { id, url: `https://www.youtube.com/watch?v=${id}` };
}
