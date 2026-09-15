import { useEffect, useRef, type RefObject } from 'react';
import type HlsType from 'hls.js';

interface PlayerProps {
  src: string;
  poster: string | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  onTimeUpdate: (time: number) => void;
  onDuration: (duration: number) => void;
}

/**
 * Plays either the finished MP4 or, while the encoder is still connected, the
 * growing HLS event playlist — which stays fully seekable from the start.
 */
export function Player({ src, poster, videoRef, onTimeUpdate, onDuration }: PlayerProps) {
  const hlsRef = useRef<HlsType | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    hlsRef.current?.destroy();
    hlsRef.current = null;
    let disposed = false;

    // hls.js is by far the heaviest dependency, so it only loads for HLS
    // sources on browsers without native support.
    if (src.endsWith('.m3u8') && !video.canPlayType('application/vnd.apple.mpegurl')) {
      void import('hls.js').then(({ default: Hls }) => {
        if (disposed || !Hls.isSupported()) return;
        const hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 90 });
        hls.loadSource(src);
        hls.attachMedia(video);
        hlsRef.current = hls;
      });
    } else {
      video.src = src;
    }

    return () => {
      disposed = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [src, videoRef]);

  return (
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
    />
  );
}
