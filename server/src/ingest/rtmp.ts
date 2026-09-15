import net from 'node:net';
import path from 'node:path';
import NodeMediaServer, { type NmsSession } from 'node-media-server';
import { config } from '../config.ts';
import { db } from '../db/index.ts';
import type { StreamRow } from '../db/types.ts';
import { createLogger } from '../util/logger.ts';
import { startRecording, stopRecording } from './recorder.ts';

const log = createLogger('rtmp');

/** Stream key -> stream row. The key is the RTMP stream name an encoder publishes to. */
function findStreamByKey(key: string): StreamRow | undefined {
  return db.prepare('SELECT * FROM streams WHERE stream_key = ?').get(key) as StreamRow | undefined;
}

let server: NodeMediaServer | undefined;
let listening = false;

/** Whether ingest is accepting connections right now. */
export function isIngestListening(): boolean {
  return listening;
}

/**
 * Node-Media-Server reports a bind failure as an async 'error' event on a socket
 * this module cannot reach, which would take the whole process down. Probing
 * first keeps a busy port from killing the web server.
 */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '0.0.0.0');
  });
}

/** Resolves whether ingest actually came up; a failure is logged, never fatal. */
export async function startRtmpServer(): Promise<boolean> {
  if (!(await portIsFree(config.rtmpPort))) {
    log.error(`port ${config.rtmpPort} is already in use — RTMP ingest is disabled for this run`);
    listening = false;
    return false;
  }

  server = new NodeMediaServer({
    bind: '0.0.0.0',
    rtmp: { port: config.rtmpPort },
    // Recording is driven by this app's own ffmpeg pipeline, not by NMS.
    record: { auto: false, path: path.join(config.dataDir, 'nms-record') },
    store: { path: path.join(config.dataDir, 'nms-store') },
    webadmin: { enable: false },
  });

  // postPublish fires before the session is flagged as a publisher, so the flag
  // is not usable here; the event itself only fires for publishers.
  server.on('postPublish', (session: NmsSession) => {
    if (session.streamApp !== config.rtmpApp) {
      log.warn(`rejecting publish to unknown app "${session.streamApp}" from ${session.ip}`);
      session.close();
      return;
    }
    const stream = findStreamByKey(session.streamName);
    if (!stream) {
      log.warn(`rejecting publish with unknown stream key from ${session.ip}`);
      session.close();
      return;
    }
    if (!stream.auto_record) {
      log.info(`stream ${stream.name} is live but auto-record is off`);
      return;
    }
    // The publisher is registered immediately after this handler returns, so let
    // the event loop turn over before the recorder subscribes to the broadcast.
    setTimeout(() => {
      if (!findStreamByKey(session.streamName)) return;
      startRecording(stream);
    }, 500);
  });

  server.on('donePublish', (session: NmsSession) => {
    if (!session.isPublisher) return;
    const stream = findStreamByKey(session.streamName);
    if (!stream) return;
    log.info(`publisher for ${stream.name} disconnected`);
    void stopRecording(stream.id);
  });

  await server.run();
  listening = true;
  log.info(`rtmp ingest listening on :${config.rtmpPort} (app "${config.rtmpApp}")`);
  return true;
}

export async function stopRtmpServer(): Promise<void> {
  listening = false;
  await server?.stop();
  server = undefined;
}
