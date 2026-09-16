import crypto from 'node:crypto';
import { deleteSetting, getSetting, setSetting } from '../db/index.ts';

const URL_KEY = 'webhook.url';
const SECRET_KEY = 'webhook.secret';

export function webhookConfig(): { url: string | null; hasSecret: boolean } {
  return { url: getSetting(URL_KEY) ?? null, hasSecret: Boolean(getSetting(SECRET_KEY)) };
}

export function setWebhook(url: string, secret?: string): void {
  setSetting(URL_KEY, url.trim());
  if (secret === undefined) return;
  if (secret === '') deleteSetting(SECRET_KEY);
  else setSetting(SECRET_KEY, secret);
}

export function clearWebhook(): void {
  deleteSetting(URL_KEY);
  deleteSetting(SECRET_KEY);
}

export interface WebhookPayload {
  clipId: string;
  title: string;
  durationSeconds: number | null;
  bytes: number | null;
  mediaUrl: string;
  thumbnailUrl: string | null;
  recordingId: string | null;
  publishedAt: string;
}

/** POST the clip metadata to an arbitrary endpoint, optionally HMAC-signed. */
export async function deliver(payload: WebhookPayload, overrideUrl?: string): Promise<{ status: number }> {
  const url = overrideUrl ?? getSetting(URL_KEY);
  if (!url) throw new Error('no webhook URL configured');

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const secret = getSetting(SECRET_KEY);
  if (secret) {
    headers['x-editlive-signature'] = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  }

  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`webhook endpoint returned ${res.status}`);
  return { status: res.status };
}
