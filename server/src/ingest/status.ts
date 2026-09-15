import { config } from '../config.ts';
import { isIngestListening } from './rtmp.ts';

export interface IngestEndpoint {
  url: string;
  host: string;
  port: number;
  app: string;
}

/** Why no encoder can reach this deployment, when that is the case. */
export type IngestProblem = 'no-proxy' | 'proxy-port-conflict' | 'not-listening';

/**
 * The RTMP endpoint to hand an encoder, or the reason there isn't one. A proxy
 * aimed at the web server's port cannot carry RTMP, and neither can an address
 * whose listener never came up, so both count as having no endpoint at all.
 */
export function ingestStatus(): { endpoint: IngestEndpoint | null; problem: IngestProblem | null } {
  if (config.rtmpPortConflict) return { endpoint: null, problem: 'proxy-port-conflict' };
  if (!isIngestListening()) return { endpoint: null, problem: 'not-listening' };
  if (!config.rtmpPublicHost) return { endpoint: null, problem: 'no-proxy' };
  return {
    endpoint: {
      url: `rtmp://${config.rtmpPublicHost}:${config.rtmpPublicPort}/${config.rtmpApp}`,
      host: config.rtmpPublicHost,
      port: config.rtmpPublicPort,
      app: config.rtmpApp,
    },
    problem: null,
  };
}
