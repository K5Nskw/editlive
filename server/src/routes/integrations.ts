import { Router } from 'express';
import { z } from 'zod';
import { issueOauthState, verifyOauthState } from '../auth.ts';
import { buffer, webhook, youtube } from '../publish/index.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('integrations');

export const integrationsRouter: Router = Router();

integrationsRouter.get('/', async (_req, res) => {
  const yt = youtube.connectionStatus();
  const bufferToken = buffer.accessToken();
  res.json({
    youtube: { ...yt, redirectUri: youtube.redirectUri() },
    buffer: { connected: Boolean(bufferToken) },
    webhook: webhook.webhookConfig(),
  });
});

integrationsRouter.get('/youtube/auth-url', (_req, res) => {
  if (!youtube.isConfigured()) {
    res.status(400).json({
      error: 'GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET を Railway の環境変数に設定してください',
      redirectUri: youtube.redirectUri(),
    });
    return;
  }
  res.json({ url: youtube.authUrl(issueOauthState()) });
});

/** Google redirects the operator's browser back here after consent. */
integrationsRouter.get('/youtube/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  const state = typeof req.query.state === 'string' ? req.query.state : undefined;
  if (typeof req.query.error === 'string') {
    res.redirect(`/settings?youtube=error&message=${encodeURIComponent(req.query.error)}`);
    return;
  }
  if (!code || !verifyOauthState(state)) {
    res.redirect('/settings?youtube=error&message=invalid_state');
    return;
  }
  try {
    const channel = await youtube.completeAuth(code);
    res.redirect(`/settings?youtube=connected&channel=${encodeURIComponent(channel?.title ?? '')}`);
  } catch (err) {
    log.error('YouTube OAuth callback failed', err);
    const message = err instanceof Error ? err.message : 'unknown error';
    res.redirect(`/settings?youtube=error&message=${encodeURIComponent(message)}`);
  }
});

integrationsRouter.post('/youtube/disconnect', (_req, res) => {
  youtube.disconnect();
  res.json({ ok: true });
});

integrationsRouter.post('/buffer', (req, res) => {
  const parsed = z.object({ token: z.string().trim().min(10) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'アクセストークンを入力してください' });
    return;
  }
  buffer.setAccessToken(parsed.data.token);
  res.json({ ok: true });
});

integrationsRouter.delete('/buffer', (_req, res) => {
  buffer.clearAccessToken();
  res.json({ ok: true });
});

integrationsRouter.get('/buffer/profiles', async (_req, res) => {
  try {
    res.json({ profiles: await buffer.listProfiles() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Buffer API error' });
  }
});

integrationsRouter.post('/webhook', (req, res) => {
  const parsed = z.object({ url: z.url(), secret: z.string().max(200).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'URL の形式が正しくありません' });
    return;
  }
  webhook.setWebhook(parsed.data.url, parsed.data.secret);
  res.json({ ok: true, webhook: webhook.webhookConfig() });
});

integrationsRouter.delete('/webhook', (_req, res) => {
  webhook.clearWebhook();
  res.json({ ok: true });
});
