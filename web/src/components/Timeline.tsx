import { useCallback, useEffect, useRef, useState } from 'react';
import type { Analysis, SpriteInfo } from '../types';
import { clamp, formatTimecode } from '../util';

/** The filmstrip that grows during a broadcast, one image per interval. */
export interface LiveFilmstrip {
  count: number;
  interval: number;
  baseUrl: string;
}

interface TimelineProps {
  duration: number;
  analysis: Analysis | null;
  sprite: SpriteInfo | null;
  liveFilmstrip: LiveFilmstrip | null;
  currentTime: number;
  inPoint: number;
  outPoint: number;
  onSeek: (time: number) => void;
  onRangeChange: (inPoint: number, outPoint: number) => void;
}

const FILMSTRIP_H = 62;
const CURVE_H = 70;

/** One canvas draws the filmstrip, the loudness/motion curve and the cuts. */
export function Timeline({
  duration,
  analysis,
  sprite,
  liveFilmstrip,
  currentTime,
  inPoint,
  outPoint,
  onSeek,
  onRangeChange,
}: TimelineProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sheetsRef = useRef<HTMLImageElement[]>([]);
  const liveTilesRef = useRef<Map<number, HTMLImageElement>>(new Map());
  const [sheetsReady, setSheetsReady] = useState(0);
  const [tilesReady, setTilesReady] = useState(0);
  const [width, setWidth] = useState(0);
  const dragRef = useRef<'in' | 'out' | 'seek' | null>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(box);
    setWidth(box.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    sheetsRef.current = [];
    setSheetsReady(0);
    if (!sprite) return;
    let cancelled = false;
    sprite.sheets.forEach((name, index) => {
      const img = new Image();
      img.src = `${sprite.baseUrl}${name}`;
      img.onload = () => {
        if (cancelled) return;
        sheetsRef.current[index] = img;
        setSheetsReady((n) => n + 1);
      };
    });
    return () => {
      cancelled = true;
    };
  }, [sprite]);

  useEffect(() => {
    liveTilesRef.current = new Map();
    setTilesReady(0);
  }, [liveFilmstrip?.baseUrl]);

  useEffect(() => {
    if (!liveFilmstrip) return;
    let cancelled = false;
    for (let index = 0; index < liveFilmstrip.count; index++) {
      if (liveTilesRef.current.has(index)) continue;
      const img = new Image();
      liveTilesRef.current.set(index, img);
      img.src = `${liveFilmstrip.baseUrl}thumb_${String(index).padStart(6, '0')}.jpg`;
      img.onload = () => {
        if (!cancelled) setTilesReady((n) => n + 1);
      };
      img.onerror = () => liveTilesRef.current.delete(index);
    }
    return () => {
      cancelled = true;
    };
  }, [liveFilmstrip]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || duration <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const height = FILMSTRIP_H + CURVE_H;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // --- filmstrip -------------------------------------------------------
    ctx.fillStyle = '#0d111a';
    ctx.fillRect(0, 0, width, FILMSTRIP_H);
    if (sprite && sheetsReady > 0) {
      const tileAspect = sprite.tileWidth / sprite.tileHeight;
      const drawW = FILMSTRIP_H * tileAspect;
      for (let x = 0; x < width; x += drawW) {
        const time = (x / width) * duration;
        const index = Math.min(sprite.count - 1, Math.floor(time / sprite.interval));
        if (index < 0) continue;
        const perSheet = sprite.cols * sprite.rows;
        const sheet = sheetsRef.current[Math.floor(index / perSheet)];
        if (!sheet) continue;
        const within = index % perSheet;
        const sx = (within % sprite.cols) * sprite.tileWidth;
        const sy = Math.floor(within / sprite.cols) * sprite.tileHeight;
        ctx.drawImage(sheet, sx, sy, sprite.tileWidth, sprite.tileHeight, x, 0, drawW + 1, FILMSTRIP_H);
      }
      ctx.fillStyle = 'rgba(11,14,20,0.35)';
      ctx.fillRect(0, 0, width, FILMSTRIP_H);
    } else if (liveFilmstrip && tilesReady > 0) {
      // Live: one image per interval, appearing as the broadcast goes on.
      let drawn = 0;
      for (let index = 0; index < liveFilmstrip.count; index++) {
        const tile = liveTilesRef.current.get(index);
        if (!tile?.complete || tile.naturalWidth === 0) continue;
        const x = ((index * liveFilmstrip.interval) / duration) * width;
        const drawW = Math.max(2, (liveFilmstrip.interval / duration) * width);
        ctx.drawImage(tile, x, 0, drawW + 1, FILMSTRIP_H);
        drawn += 1;
      }
      ctx.fillStyle = 'rgba(11,14,20,0.35)';
      ctx.fillRect(0, 0, width, FILMSTRIP_H);
      if (drawn === 0) {
        ctx.fillStyle = '#5f6b83';
        ctx.font = '11px sans-serif';
        ctx.fillText('サムネイルを生成中…', 10, FILMSTRIP_H / 2 + 4);
      }
    } else {
      ctx.fillStyle = '#5f6b83';
      ctx.font = '11px sans-serif';
      ctx.fillText(sprite ? 'サムネイル読み込み中…' : 'サムネイルを生成中…', 10, FILMSTRIP_H / 2 + 4);
    }

    // --- loudness / motion curve -----------------------------------------
    const top = FILMSTRIP_H;
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, top, width, CURVE_H);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = top + (CURVE_H / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    if (analysis && analysis.energy.length > 0) {
      const base = top + CURVE_H - 4;
      const span = CURVE_H - 12;
      const gradient = ctx.createLinearGradient(0, top, 0, top + CURVE_H);
      gradient.addColorStop(0, 'rgba(77,141,255,0.55)');
      gradient.addColorStop(1, 'rgba(77,141,255,0.03)');

      ctx.beginPath();
      ctx.moveTo(0, base);
      for (let x = 0; x <= width; x++) {
        const time = (x / width) * duration;
        const idx = clamp(Math.floor(time / analysis.interval), 0, analysis.energy.length - 1);
        ctx.lineTo(x, base - (analysis.energy[idx] ?? 0) * span);
      }
      ctx.lineTo(width, base);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();

      ctx.beginPath();
      for (let x = 0; x <= width; x++) {
        const time = (x / width) * duration;
        const idx = clamp(Math.floor(time / analysis.interval), 0, analysis.energy.length - 1);
        const y = base - (analysis.energy[idx] ?? 0) * span;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = '#4d8dff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.strokeStyle = 'rgba(61,220,151,0.55)';
      ctx.lineWidth = 1;
      for (const cut of analysis.scenes) {
        const x = (cut / duration) * width;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + 9);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = '#5f6b83';
      ctx.font = '11px sans-serif';
      ctx.fillText('波形は配信終了後に生成されます', 10, top + CURVE_H / 2);
    }

    // --- dim the material outside the selection --------------------------
    ctx.fillStyle = 'rgba(6,9,15,0.62)';
    const inX = (inPoint / duration) * width;
    const outX = (outPoint / duration) * width;
    ctx.fillRect(0, 0, Math.max(0, inX), height);
    ctx.fillRect(outX, 0, Math.max(0, width - outX), height);
  }, [analysis, duration, inPoint, outPoint, liveFilmstrip, sheetsReady, sprite, tilesReady, width]);

  useEffect(() => {
    draw();
  }, [draw]);

  const timeAt = useCallback(
    (clientX: number): number => {
      const box = boxRef.current;
      if (!box || duration <= 0) return 0;
      const rect = box.getBoundingClientRect();
      return clamp(((clientX - rect.left) / rect.width) * duration, 0, duration);
    },
    [duration],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const mode = dragRef.current;
      if (!mode) return;
      const time = timeAt(event.clientX);
      if (mode === 'seek') onSeek(time);
      else if (mode === 'in') onRangeChange(Math.min(time, outPoint - 0.5), outPoint);
      else onRangeChange(inPoint, Math.max(time, inPoint + 0.5));
    },
    [inPoint, onRangeChange, onSeek, outPoint, timeAt],
  );

  useEffect(() => {
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [onPointerMove]);

  const pct = (time: number) => `${duration > 0 ? (time / duration) * 100 : 0}%`;

  return (
    <div className="timeline-wrap">
      <div
        className="timeline"
        ref={boxRef}
        style={{ height: FILMSTRIP_H + CURVE_H }}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).classList.contains('tl-handle')) return;
          dragRef.current = 'seek';
          onSeek(timeAt(e.clientX));
        }}
      >
        <canvas ref={canvasRef} style={{ height: FILMSTRIP_H + CURVE_H }} />
        <div className="tl-selection" style={{ left: pct(inPoint), width: pct(outPoint - inPoint) }} />
        <div
          className="tl-handle"
          style={{ left: pct(inPoint) }}
          onPointerDown={(e) => {
            e.stopPropagation();
            dragRef.current = 'in';
          }}
          title="イン点"
        />
        <div
          className="tl-handle"
          style={{ left: pct(outPoint) }}
          onPointerDown={(e) => {
            e.stopPropagation();
            dragRef.current = 'out';
          }}
          title="アウト点"
        />
        <div className="tl-playhead" style={{ left: pct(currentTime) }} />
      </div>
      <div className="tl-legend">
        <span>
          <i className="swatch" style={{ background: '#4d8dff' }} /> 音量と動きの大きさ
        </span>
        <span>
          <i className="swatch" style={{ background: 'rgba(61,220,151,0.8)' }} /> カット検出
        </span>
        <span style={{ marginLeft: 'auto' }}>
          選択範囲 {formatTimecode(inPoint, true)} → {formatTimecode(outPoint, true)} （
          {(outPoint - inPoint).toFixed(1)}秒）
        </span>
      </div>
    </div>
  );
}
