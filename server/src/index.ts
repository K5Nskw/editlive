import fs from 'node:fs';
import { createApp } from './app.ts';
import { config } from './config.ts';
import { db } from './db/index.ts';
import type { StreamRow } from './db/types.ts';
import { registerHandlers } from './jobs/handlers.ts';
import { startJobRunner, stopJobRunner } from './jobs/queue.ts';
import { recoverInterruptedRecordings, stopAll } from './ingest/recorder.ts';
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

async function main(): Promise<void> {
  seedDefaultStream();
  registerHandlers();
  recoverInterruptedRecordings();
  startJobRunner();

  await startRtmpServer();

  const app = createApp();
  const server = app.listen(config.port, () => {
    log.info(`http listening on :${config.port} (${config.publicUrl})`);
    const stream = db.prepare('SELECT * FROM streams ORDER BY created_at LIMIT 1').get() as StreamRow | undefined;
    if (stream) {
      log.info(`ingest: rtmp://${config.rtmpPublicHost}:${config.rtmpPublicPort}/${config.rtmpApp} key=${stream.stream_key}`);
    }
    if (config.generatedPassword) {
      log.warn(`APP_PASSWORD is not set — this run's login password is "${config.generatedPassword}"`);
    }
  });

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
