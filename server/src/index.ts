import fs from 'node:fs';
import { createApp } from './app.ts';
import { config } from './config.ts';
import { ingestStatus } from './ingest/status.ts';
import { db } from './db/index.ts';
import type { StreamRow } from './db/types.ts';
import { registerHandlers } from './jobs/handlers.ts';
import { startJobRunner, stopJobRunner } from './jobs/queue.ts';
import { recoverInterruptedRecordings, stopAll } from './ingest/recorder.ts';
import { reconcileClips } from './util/storage.ts';
import { startRtmpServer, stopRtmpServer } from './ingest/rtmp.ts';
import { newId, newStreamKey } from './util/ids.ts';
import { createLogger } from './util/logger.ts';

const log = createLogger('main');

for (const dir of [config.recordingsDir, config.clipsDir, config.tmpDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

/** A fresh deployment should have something to point an encoder at. */
function seedDefaultStream(): void {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM streams').get() as { n: number }).n;
  if (count > 0) return;
  db.prepare('INSERT INTO streams (id, name, stream_key, auto_record, created_at) VALUES (?, ?, ?, 1, ?)').run(
    newId('stm_'),
    'メイン配信',
    newStreamKey(),
    Date.now(),
  );
  log.info('created the default ingest stream');
}

function reportIngest(): void {
  const { endpoint, problem } = ingestStatus();
  const stream = db.prepare('SELECT * FROM streams ORDER BY created_at LIMIT 1').get() as StreamRow | undefined;

  if (endpoint) {
    log.info(`ingest: ${endpoint.url}${stream ? ` key=${stream.stream_key}` : ''}`);
    return;
  }
  if (problem === 'not-listening') {
    log.warn('RTMP ingest is not listening, so no encoder can publish to this deployment');
    return;
  }
  if (problem === 'proxy-port-conflict') {
    log.warn(
      `the TCP proxy and the web server both want port ${config.requestedRtmpPort}, so RTMP moved to ` +
        `${config.rtmpPort}. Fix it either way: point the TCP proxy at ${config.rtmpPort}, or give the web ` +
        `server a port of its own (set PORT=3000 and the HTTP domain's target port to 3000) and leave the ` +
        'TCP proxy on 1935.',
    );
    return;
  }
  log.warn(
    `no public RTMP endpoint: add a Railway TCP Proxy forwarding to container port ${config.rtmpPort}, ` +
      'or set RTMP_PUBLIC_HOST / RTMP_PUBLIC_PORT.',
  );
}

async function main(): Promise<void> {
  seedDefaultStream();
  registerHandlers();
  recoverInterruptedRecordings();
  reconcileClips();
  startJobRunner();

  // The web server comes up first and its port is never shared: losing ingest
  // costs recordings, losing HTTP costs every way of noticing that.
  const app = createApp();
  const server = app.listen(config.port, () => {
    log.info(`http listening on :${config.port} (${config.publicUrl})`);
    if (config.generatedPassword) {
      log.warn(`APP_PASSWORD is not set — this run's login password is "${config.generatedPassword}"`);
    }
    if (config.storageIsEphemeral) {
      log.warn(
        `no volume attached: recordings in ${config.dataDir} are lost on the next deploy. ` +
          'Attach a Railway Volume (any mount path) and redeploy.',
      );
    }
  });

  server.on('error', (err) => {
    log.error(`the web server could not listen on :${config.port}`, err);
    process.exit(1);
  });

  // Ingest is best-effort: a failure here leaves the editor and every existing
  // recording reachable instead of crash-looping the deployment.
  try {
    await startRtmpServer();
  } catch (err) {
    log.error('rtmp ingest failed to start', err);
  }
  reportIngest();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    server.close();
    stopJobRunner();
    await stopAll();
    await stopRtmpServer();
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('failed to start', err);
  process.exit(1);
});
