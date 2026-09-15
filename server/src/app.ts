import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.ts';
import { requireAuth } from './auth.ts';
import { authRouter } from './routes/auth.ts';
import { clipsRouter } from './routes/clips.ts';
import { integrationsRouter } from './routes/integrations.ts';
import { jobsRouter } from './routes/jobs.ts';
import { publicMediaRouter, recordingMediaRouter } from './routes/media.ts';
import { recordingsRouter } from './routes/recordings.ts';
import { streamsRouter } from './routes/streams.ts';
import { createLogger } from './util/logger.ts';

const log = createLogger('http');
const here = path.dirname(fileURLToPath(import.meta.url));

/** The Vite build lands in server/public, next to dist/ once compiled. */
function findWebRoot(): string | undefined {
  return [path.join(here, '../public'), path.join(here, '../../public')].find((p) =>
    fs.existsSync(path.join(p, 'index.html')),
  );
}

export function createApp(): express.Express {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      ingest: {
        url: `rtmp://${config.rtmpPublicHost}:${config.rtmpPublicPort}/${config.rtmpApp}`,
        host: config.rtmpPublicHost,
        port: config.rtmpPublicPort,
        app: config.rtmpApp,
      },
      publicUrl: config.publicUrl,
      maxRecordingHours: config.maxRecordingSeconds / 3600,
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/p', publicMediaRouter);
  app.use('/media/recordings', recordingMediaRouter);

  app.use('/api/streams', requireAuth, streamsRouter);
  app.use('/api/recordings', requireAuth, recordingsRouter);
  app.use('/api/clips', requireAuth, clipsRouter);
  app.use('/api/integrations', requireAuth, integrationsRouter);
  app.use('/api/jobs', requireAuth, jobsRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'unknown endpoint' });
  });

  const webRoot = findWebRoot();
  if (webRoot) {
    app.use(express.static(webRoot, { index: false, maxAge: '1h' }));
    // Client-side routing: every non-API path renders the SPA shell.
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(webRoot, 'index.html'));
    });
  } else {
    log.warn('no web build found — run "npm run build" to serve the UI');
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'internal error';
    log.error('request failed', err);
    if (res.headersSent) return;
    res.status(500).json({ error: message });
  });

  return app;
}
