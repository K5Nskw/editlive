import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type HlsType from 'hls.js';

interface PlayerProps {
  src: string;
  poster: string | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  onTimeUpdate: (time: number) => void;
  onDuration: (duration: number) => void;
}

const RETRY_MS = 2000;

/**
 * Plays either the finished MP4 or, while the encoder is still connected, the
 * growing HLS event playlist — which stays fully seekable from the start.
 *
 * A live playlist does not exist until the recorder has written its first
 * segment, so the first few seconds of a broadcast answer 404. Rather than let
 * hls.js give up and leave a permanently black player, every fatal load error
 * is retried until the stream shows up.
 */
export function Player({ src, poster, videoRef, onTimeUpdate, onDuration }: PlayerProps) {
  const hlsRef = useRef<HlsType | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let disposed = false;
    let retryTimer: number | undefined;
    let attempts = 0;

    const isHls = src.endsWith('.m3u8');
    setWaiting(isHls ? '映像を待っています…' : null);

    if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
      void import('hls.js').then(({ default: Hls }) => {
        if (disposed) return;
        if (!Hls.isSupported()) {
          setWaiting('このブラウザは HLS 再生に対応していません');
          return;
        }
        const hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 90 });
        hlsRef.current = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          attempts = 0;
          setWaiting(null);
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || disposed) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }
          // Most often the playlist is not written yet; keep asking for it.
          attempts += 1;
          setWaiting(`映像を待っています… (${attempts})`);
          window.clearTimeout(retryTimer);
          retryTimer = window.setTimeout(() => {
            if (disposed) return;
            hls.loadSource(src);
            hls.startLoad();
          }, RETRY_MS);
        });

        hls.loadSource(src);
        hls.attachMedia(video);
      });
    } else if (isHls) {
      // Safari plays HLS natively but reports the same 404 as a media error.
      video.src = src;
      const onError = () => {
        if (disposed) return;
        attempts += 1;
        setWaiting(`映像を待っています… (${attempts})`);
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => {
          if (!disposed) video.load();
        }, RETRY_MS);
      };
      video.addEventListener('error', onError);
      video.addEventListener('loadedmetadata', () => setWaiting(null));
    } else {
      video.src = src;
    }

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [src, videoRef, reloadKey]);

  return (
    <div className="player-frame">
      <video
        ref={videoRef}
        poster={poster ?? undefined}
        controls
        playsInline
        preload="auto"
        onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
        onDurationChange={(e) => {
          if (Number.isFinite(e.currentTarget.duration)) onDuration(e.currentTarget.duration);
        }}
        onPlaying={() => setWaiting(null)}
      />
      {waiting && (
        <div className="player-overlay">
          <span>{waiting}</span>
          <button className="small" onClick={reload}>
            再読み込み
          </button>
        </div>
      )}
    </div>
  );
}
