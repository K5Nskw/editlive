import { config } from '../config.ts';
import { deleteSetting, getSetting, setSetting } from '../db/index.ts';

const TOKEN_KEY = 'buffer.token';
const API = 'https://api.bufferapp.com/1';

export function accessToken(): string | undefined {
  return getSetting(TOKEN_KEY) ?? config.bufferToken;
}

export function setAccessToken(token: string): void {
  setSetting(TOKEN_KEY, token.trim());
}

export function clearAccessToken(): void {
  deleteSetting(TOKEN_KEY);
}

export interface BufferProfile {
  id: string;
  service: string;
  username: string;
  avatar: string | null;
}

interface RawProfile {
  id?: string;
  service?: string;
  formatted_username?: string;
  service_username?: string;
  avatar?: string;
}

function requireToken(): string {
  const token = accessToken();
  if (!token) throw new Error('Buffer is not connected yet — add an access token on the settings page');
  return token;
}

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${API}${path}`, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Buffer API returned ${res.status}`;
    throw new Error(message);
  }
  return body;
}

export async function listProfiles(): Promise<BufferProfile[]> {
  const token = requireToken();
  const raw = (await call(`/profiles.json?access_token=${encodeURIComponent(token)}`)) as RawProfile[];
  return (Array.isArray(raw) ? raw : []).map((p) => ({
    id: p.id ?? '',
    service: p.service ?? 'unknown',
    username: p.formatted_username ?? p.service_username ?? '',
    avatar: p.avatar ?? null,
  }));
}

export interface BufferPostOptions {
  profileIds: string[];
  text: string;
  /** Public URL of the rendered clip; Buffer attaches it as the update's media. */
  mediaUrl: string;
  mediaTitle?: string;
  mediaDescription?: string;
  thumbnailUrl?: string;
  /** Post immediately instead of adding to the queue. */
  now?: boolean;
}

export interface BufferPostResult {
  ids: string[];
  url: string | null;
}

/**
 * Buffer's public API takes a link plus text rather than a video file, so the
 * clip is shared through its public URL on this deployment.
 */
export async function createUpdate(opts: BufferPostOptions): Promise<BufferPostResult> {
  const token = requireToken();
  if (opts.profileIds.length === 0) throw new Error('select at least one Buffer profile');

  const form = new URLSearchParams();
  form.set('access_token', token);
  form.set('text', opts.text);
  for (const id of opts.profileIds) form.append('profile_ids[]', id);
  form.set('media[link]', opts.mediaUrl);
  if (opts.mediaTitle) form.set('media[title]', opts.mediaTitle.slice(0, 200));
  if (opts.mediaDescription) form.set('media[description]', opts.mediaDescription.slice(0, 500));
  if (opts.thumbnailUrl) {
    form.set('media[thumbnail]', opts.thumbnailUrl);
    form.set('media[picture]', opts.thumbnailUrl);
  }
  if (opts.now) form.set('now', 'true');

  const body = (await call('/updates/create.json', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })) as { success?: boolean; updates?: Array<{ id?: string; service_link?: string }>; message?: string };

  if (body.success === false) throw new Error(body.message ?? 'Buffer rejected the update');
  const updates = body.updates ?? [];
  return {
    ids: updates.map((u) => u.id).filter((id): id is string => Boolean(id)),
    url: updates.find((u) => u.service_link)?.service_link ?? null,
  };
}
