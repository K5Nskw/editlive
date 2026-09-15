declare module 'node-media-server' {
  /** The subset of Node-Media-Server's BaseSession this app relies on. */
  export interface NmsSession {
    id: string;
    ip: string;
    isPublisher: boolean;
    protocol: string;
    streamApp: string;
    streamName: string;
    streamPath: string;
    streamQuery: Record<string, string>;
    createTime: number;
    endTime: number;
    videoWidth: number;
    videoHeight: number;
    videoFramerate: number;
    audioSamplerate: number;
    inBytes: number;
    outBytes: number;
    close: () => void;
  }

  export interface NmsConfig {
    bind?: string;
    rtmp?: { port?: number };
    http?: { port?: number };
    record?: { auto?: boolean; path?: string };
    store?: { path?: string; flushInterval?: number; durability?: string };
    webadmin?: { enable?: boolean };
    auth?: { play?: boolean; publish?: boolean; secret?: string };
    notify?: { url?: string };
  }

  type NmsEvent = 'prePublish' | 'postPublish' | 'donePublish' | 'prePlay' | 'postPlay' | 'donePlay';

  export default class NodeMediaServer {
    constructor(config: NmsConfig, configPath?: string);
    on(event: NmsEvent, listener: (session: NmsSession) => void): void;
    run(): Promise<void>;
    stop(): Promise<void>;
  }
}
