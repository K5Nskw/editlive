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

export async function startRtmpServer(): Promise<void> {
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
  log.info(`rtmp ingest listening on :${config.rtmpPort} (app "${config.rtmpApp}")`);
}

export async function stopRtmpServer(): Promise<void> {
  await server?.stop();
  server = undefined;
}
