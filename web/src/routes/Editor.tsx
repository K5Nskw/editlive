import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Player } from '../components/Player';
import { Timeline } from '../components/Timeline';
import { PublishDialog } from '../components/PublishDialog';
import { usePolling } from '../hooks';
import type { Analysis, Aspect, Clip, FitMode, Highlight, Integrations, Publication, Recording, RenderSpec } from '../types';
import { clamp, formatBytes, formatDateTime, formatDuration, formatTimecode } from '../util';

const DEFAULT_SPEC: RenderSpec = {
  aspect: '9:16',
  fit: 'blur',
  focusX: 0.5,
  focusY: 0.5,
  resolution: 1080,
  mute: false,
  fadeIn: 0.3,
  fadeOut: 0.4,
  overlayText: '',
  overlayPosition: 'bottom',
};

const ASPECTS: Array<{ value: Aspect; label: string }> = [
  { value: '9:16', label: '9:16 縦' },
  { value: '1:1', label: '1:1 正方形' },
  { value: '4:5', label: '4:5' },
  { value: '16:9', label: '16:9 横' },
];

const ANALYSIS_LABEL: Record<Recording['analysisStatus'], string> = {
  pending: '解析待ち',
  running: '解析中',
  ready: '解析済み',
  failed: '解析失敗',
};

interface EditorProps {
  recordingId: string;
  integrations: Integrations | null;
  onNotify: (message: string, error?: boolean) => void;
  onBack: () => void;
}

export function Editor({ recordingId, integrations, onNotify, onBack }: EditorProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [publications, setPublications] = useState<Publication[]>([]);

  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [inPoint, setInPoint] = useState(0);
  const [outPoint, setOutPoint] = useState(20);
  const [title, setTitle] = useState('');
  const [spec, setSpec] = useState<RenderSpec>(DEFAULT_SPEC);
  const [sensitivity, setSensitivity] = useState(0.5);
  const [creating, setCreating] = useState(false);
  const [publishTarget, setPublishTarget] = useState<Clip | null>(null);
  const [notFound, setNotFound] = useState(false);

  const duration = recording && recording.duration > 0 ? recording.duration : videoDuration;

  const load = useCallback(async () => {
    try {
      const data = await api.recording(recordingId);
      setRecording(data.recording);
      setHighlights(data.highlights);
      setClips(data.clips);
      setTitle((prev) => prev || `${data.recording.title} のクリップ`);
    } catch {
      setNotFound(true);
    }
  }, [recordingId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The analysis file only appears once the analyse job finishes.
  useEffect(() => {
    if (recording?.analysisStatus !== 'ready') return;
    api
      .analysis(recordingId)
      .then((res) => setAnalysis(res.analysis))
      .catch(() => setAnalysis(null));
  }, [recordingId, recording?.analysisStatus]);

  const needsPolling =
    recording?.status === 'live' ||
    recording?.status === 'processing' ||
    recording?.analysisStatus === 'pending' ||
    recording?.analysisStatus === 'running' ||
    clips.some((c) => c.status === 'queued' || c.status === 'rendering');

  usePolling(load, 3000, Boolean(needsPolling));

  useEffect(() => {
    if (duration > 0 && outPoint <= inPoint) setOutPoint(Math.min(duration, inPoint + 20));
  }, [duration, inPoint, outPoint]);

  const seek = useCallback((time: number) => {
    const video = videoRef.current;
    setCurrentTime(time);
    if (video) video.currentTime = time;
  }, []);

  const loadHighlight = useCallback(
    (hl: Highlight) => {
      setInPoint(hl.start);
      setOutPoint(hl.end);
      seek(hl.start);
    },
    [seek],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const video = videoRef.current;
      const step = event.shiftKey ? 5 : 1;
      switch (event.key.toLowerCase()) {
        case ' ':
          event.preventDefault();
          if (video) void (video.paused ? video.play() : video.pause());
          break;
        case 'i':
          setInPoint(Math.min(currentTime, outPoint - 0.5));
          break;
        case 'o':
          setOutPoint(Math.max(currentTime, inPoint + 0.5));
          break;
        case 'arrowleft':
        case 'j':
          event.preventDefault();
          seek(clamp(currentTime - step, 0, duration));
          break;
        case 'arrowright':
        case 'l':
          event.preventDefault();
          seek(clamp(currentTime + step, 0, duration));
          break;
        case 'k':
          if (video) void (video.paused ? video.play() : video.pause());
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentTime, duration, inPoint, outPoint, seek]);

  async function createClip() {
    if (outPoint - inPoint < 0.5) {
      onNotify('選択範囲が短すぎます', true);
      return;
    }
    setCreating(true);
    try {
      const res = await api.createClip({
        recordingId,
        title: title.trim() || 'クリップ',
        start: Number(inPoint.toFixed(2)),
        end: Number(outPoint.toFixed(2)),
        spec,
      });
      setClips((prev) => [res.clip, ...prev]);
      onNotify('書き出しキューに追加しました');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '作成に失敗しました', true);
    } finally {
      setCreating(false);
    }
  }

  async function openPublish(clip: Clip) {
    try {
      const res = await api.clip(clip.id);
      setPublications(res.publications);
      setPublishTarget(res.clip);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '読み込みに失敗しました', true);
    }
  }

  const selectionValid = outPoint - inPoint >= 0.5;
  const sortedClips = useMemo(() => [...clips].sort((a, b) => b.createdAt - a.createdAt), [clips]);

  if (notFound) {
    return (
      <div className="page">
        <div className="card empty">録画が見つかりませんでした。</div>
      </div>
    );
  }

  if (!recording) {
    return (
      <div className="page">
        <div className="card empty">読み込み中…</div>
      </div>
    );
  }

  return (
    <div className="page wide">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div className="row tight">
            <button className="ghost" onClick={onBack}>
              ← 一覧
            </button>
            <h1 style={{ margin: 0 }}>{recording.title}</h1>
            {recording.status === 'live' && (
              <span className="badge live">
                <i className="pulse" /> 配信中
              </span>
            )}
            {recording.status === 'processing' && <span className="badge warn">処理中</span>}
            {recording.status === 'failed' && <span className="badge err">失敗</span>}
            <span className="badge">{ANALYSIS_LABEL[recording.analysisStatus]}</span>
          </div>
          <p className="sub" style={{ margin: '4px 0 0' }}>
            {formatDateTime(recording.startedAt)} · {formatTimecode(duration)}
            {recording.width ? ` · ${recording.width}×${recording.height}` : ''} · {formatBytes(recording.bytes)}
          </p>
        </div>
      </div>

      {recording.error && <div className="card" style={{ borderColor: '#5a2b35', marginBottom: 16 }}>{recording.error}</div>}

      <div className="editor-grid">
        <div>
          <div className="player-shell">
            <Player
              src={recording.playbackUrl}
              poster={recording.posterUrl}
              videoRef={videoRef}
              onTimeUpdate={setCurrentTime}
              onDuration={setVideoDuration}
            />
            <div className="transport">
              <button
                onClick={() => {
                  const video = videoRef.current;
                  if (video) void (video.paused ? video.play() : video.pause());
                }}
              >
                ⏯ 再生/停止
              </button>
              <button onClick={() => setInPoint(Math.min(currentTime, outPoint - 0.5))}>[ イン点 (I)</button>
              <button onClick={() => setOutPoint(Math.max(currentTime, inPoint + 0.5))}>アウト点 (O) ]</button>
              <button className="ghost" onClick={() => seek(inPoint)}>
                イン点へ
              </button>
              <span className="spacer" style={{ flex: 1 }} />
              <span className="time-display">
                <b>{formatTimecode(currentTime, true)}</b> / {formatTimecode(duration)}
              </span>
            </div>
          </div>

          <Timeline
            duration={duration}
            analysis={analysis}
            sprite={recording.sprite}
            highlights={highlights}
            currentTime={currentTime}
            inPoint={inPoint}
            outPoint={outPoint}
            onSeek={seek}
            onRangeChange={(a, b) => {
              setInPoint(clamp(a, 0, duration));
              setOutPoint(clamp(b, 0, duration));
            }}
          />

          <div className="card" style={{ marginTop: 16 }}>
            <h2>クリップの設定</h2>
            <div className="field">
              <label>タイトル</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            </div>

            <div className="grid-2" style={{ marginTop: 12 }}>
              <div>
                <label>アスペクト比</label>
                <div className="aspect-row">
                  {ASPECTS.map((a) => (
                    <button
                      key={a.value}
                      className={`chip ${spec.aspect === a.value ? 'on' : ''}`}
                      onClick={() => setSpec({ ...spec, aspect: a.value })}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label>はみ出した部分の扱い</label>
                <div className="aspect-row">
                  {(
                    [
                      { value: 'blur', label: 'ぼかし背景に収める' },
                      { value: 'crop', label: '切り抜いて埋める' },
                    ] as Array<{ value: FitMode; label: string }>
                  ).map((f) => (
                    <button
                      key={f.value}
                      className={`chip ${spec.fit === f.value ? 'on' : ''}`}
                      onClick={() => setSpec({ ...spec, fit: f.value })}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {spec.fit === 'crop' && (
              <div className="grid-2" style={{ marginTop: 12 }}>
                <div className="field">
                  <label>切り抜き位置（左右）: {Math.round(spec.focusX * 100)}%</label>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={spec.focusX}
                    onChange={(e) => setSpec({ ...spec, focusX: Number(e.target.value) })}
                  />
                </div>
                <div className="field">
                  <label>切り抜き位置（上下）: {Math.round(spec.focusY * 100)}%</label>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={spec.focusY}
                    onChange={(e) => setSpec({ ...spec, focusY: Number(e.target.value) })}
                  />
                </div>
              </div>
            )}

            <div className="grid-2" style={{ marginTop: 12 }}>
              <div className="field">
                <label>解像度（短辺）</label>
                <select
                  value={spec.resolution}
                  onChange={(e) => setSpec({ ...spec, resolution: Number(e.target.value) })}
                >
                  <option value={720}>720p</option>
                  <option value={1080}>1080p</option>
                  <option value={1440}>1440p</option>
                </select>
              </div>
              <div className="field">
                <label>テロップの位置</label>
                <select
                  value={spec.overlayPosition}
                  onChange={(e) => setSpec({ ...spec, overlayPosition: e.target.value as 'top' | 'bottom' })}
                >
                  <option value="bottom">下</option>
                  <option value="top">上</option>
                </select>
              </div>
            </div>

            <div className="field">
              <label>テロップ（空欄なら入れません）</label>
              <input
                value={spec.overlayText}
                onChange={(e) => setSpec({ ...spec, overlayText: e.target.value })}
                placeholder="例）決勝ゴールの瞬間"
                maxLength={300}
              />
            </div>

            <div className="row" style={{ marginTop: 12 }}>
              <label className="row tight" style={{ marginBottom: 0 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={spec.mute}
                  onChange={(e) => setSpec({ ...spec, mute: e.target.checked })}
                />
                音声を消す
              </label>
              <span className="hint" style={{ marginTop: 0 }}>
                フェード {spec.fadeIn}s / {spec.fadeOut}s
              </span>
            </div>

            <div className="row" style={{ marginTop: 16, justifyContent: 'space-between' }}>
              <span className="time-display">
                選択範囲 <b>{formatTimecode(inPoint, true)}</b> → <b>{formatTimecode(outPoint, true)}</b>（
                {(outPoint - inPoint).toFixed(1)}秒）
              </span>
              <button className="primary" disabled={creating || !selectionValid} onClick={createClip}>
                {creating ? '作成中…' : 'この範囲を書き出す'}
              </button>
            </div>
            <p className="hint">
              ショートカット: Space 再生/停止 · I イン点 · O アウト点 · ←/→ 1 秒移動（Shift で 5 秒）
            </p>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>ハイライト候補</h2>
              <span className="badge">{highlights.length} 件</span>
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label>検出の感度: {Math.round(sensitivity * 100)}%</label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={sensitivity}
                onChange={(e) => setSensitivity(Number(e.target.value))}
              />
              <button
                className="small"
                style={{ marginTop: 8 }}
                disabled={recording.status === 'live' || recording.analysisStatus === 'running'}
                onClick={async () => {
                  try {
                    await api.reanalyze(recordingId, sensitivity);
                    onNotify('再解析を開始しました');
                    void load();
                  } catch (err) {
                    onNotify(err instanceof Error ? err.message : '再解析に失敗しました', true);
                  }
                }}
              >
                この感度で再解析
              </button>
            </div>

            <div className="hl-list" style={{ marginTop: 12 }}>
              {highlights.length === 0 && (
                <div className="empty">
                  {recording.status === 'live'
                    ? '配信の終了後に自動で解析します。配信中も手動で範囲を選んで書き出せます。'
                    : recording.analysisStatus === 'running' || recording.analysisStatus === 'pending'
                      ? '解析中です…'
                      : '候補が見つかりませんでした。感度を上げて再解析してみてください。'}
                </div>
              )}
              {highlights.map((hl, index) => (
                <button key={hl.id} className="hl-item" onClick={() => loadHighlight(hl)}>
                  <span className="hl-rank">#{index + 1}</span>
                  <span>
                    <div>{hl.reason}</div>
                    <div className="hl-meta">
                      {formatTimecode(hl.start)} → {formatTimecode(hl.end)}（{(hl.end - hl.start).toFixed(0)}秒）
                    </div>
                  </span>
                  <span className="score-bar">
                    <i style={{ width: `${Math.round(hl.score * 100)}%` }} />
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>書き出したクリップ</h2>
              <span className="badge">{clips.length} 件</span>
            </div>
            <div className="stack" style={{ marginTop: 12, gap: 8 }}>
              {sortedClips.length === 0 && <div className="empty">まだクリップがありません。</div>}
              {sortedClips.map((clip) => (
                <div key={clip.id} className="clip-card">
                  {clip.thumbUrl ? (
                    <img src={clip.thumbUrl} alt="" />
                  ) : (
                    <div className="thumb-fallback">{clip.status === 'failed' ? '✕' : '…'}</div>
                  )}
                  <div>
                    <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
                      <strong style={{ fontSize: 13 }}>{clip.title}</strong>
                      <span
                        className={`badge ${
                          clip.status === 'ready' ? 'ok' : clip.status === 'failed' ? 'err' : 'warn'
                        }`}
                      >
                        {clip.status === 'ready'
                          ? '完成'
                          : clip.status === 'failed'
                            ? '失敗'
                            : clip.status === 'rendering'
                              ? '書き出し中'
                              : '待機中'}
                      </span>
                    </div>
                    <div className="hl-meta">
                      {clip.spec.aspect} · {formatTimecode(clip.start)}→{formatTimecode(clip.end)} ·{' '}
                      {formatDuration(clip.duration)} · {formatBytes(clip.bytes)}
                    </div>
                    {(clip.status === 'rendering' || clip.status === 'queued') && (
                      <div className="progress">
                        <i style={{ width: `${Math.round(clip.progress * 100)}%` }} />
                      </div>
                    )}
                    {clip.error && <div className="hl-meta" style={{ color: '#ff8b95' }}>{clip.error}</div>}
                    <div className="row tight" style={{ marginTop: 7 }}>
                      {clip.status === 'ready' && (
                        <>
                          <button className="small primary" onClick={() => void openPublish(clip)}>
                            書き出し先
                          </button>
                          <a href={clip.downloadUrl ?? '#'}>
                            <button className="small">保存</button>
                          </a>
                        </>
                      )}
                      {clip.status === 'failed' && (
                        <button
                          className="small"
                          onClick={async () => {
                            await api.rerenderClip(clip.id);
                            onNotify('再書き出しを開始しました');
                            void load();
                          }}
                        >
                          やり直す
                        </button>
                      )}
                      <button
                        className="small ghost"
                        onClick={async () => {
                          setInPoint(clip.start);
                          setOutPoint(clip.end);
                          setTitle(clip.title);
                          setSpec(clip.spec);
                          seek(clip.start);
                        }}
                      >
                        設定を読み込む
                      </button>
                      <button
                        className="small danger"
                        onClick={async () => {
                          if (!window.confirm(`「${clip.title}」を削除しますか？`)) return;
                          await api.deleteClip(clip.id);
                          setClips((prev) => prev.filter((c) => c.id !== clip.id));
                        }}
                      >
                        削除
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {publishTarget && (
        <PublishDialog
          clip={publishTarget}
          integrations={integrations}
          publications={publications}
          onClose={() => setPublishTarget(null)}
          onNotify={onNotify}
          onPublished={() => {
            void openPublish(publishTarget);
          }}
        />
      )}
    </div>
  );
}
