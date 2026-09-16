import { useCallback, useMemo, useState } from 'react';
import { api } from '../api';
import { PublishDialog } from '../components/PublishDialog';
import { usePolling } from '../hooks';
import type { Clip, Integrations, Publication } from '../types';
import { copyText, formatBytes, formatDateTime, formatDuration, formatTimecode } from '../util';

interface ClipsProps {
  integrations: Integrations | null;
  onNotify: (message: string, error?: boolean) => void;
  onOpenRecording: (recordingId: string) => void;
}

type Filter = 'all' | 'ready' | 'pending' | 'failed';

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'すべて' },
  { value: 'ready', label: '完成' },
  { value: 'pending', label: '書き出し中' },
  { value: 'failed', label: '失敗' },
];

const STATUS: Record<Clip['status'], { className: string; label: string }> = {
  ready: { className: 'badge ok', label: '完成' },
  rendering: { className: 'badge warn', label: '書き出し中' },
  queued: { className: 'badge warn', label: '待機中' },
  failed: { className: 'badge err', label: '失敗' },
};

export function Clips({ integrations, onNotify, onOpenRecording }: ClipsProps) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [publishTarget, setPublishTarget] = useState<Clip | null>(null);
  const [publications, setPublications] = useState<Publication[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await api.clips();
      setClips(res.clips);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '読み込みに失敗しました', true);
    }
  }, [onNotify]);

  usePolling(load, 5000, true);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return clips.filter((clip) => {
      if (filter === 'ready' && clip.status !== 'ready') return false;
      if (filter === 'failed' && clip.status !== 'failed') return false;
      if (filter === 'pending' && clip.status !== 'queued' && clip.status !== 'rendering') return false;
      if (!needle) return true;
      return `${clip.title} ${clip.sourceTitle ?? ''}`.toLowerCase().includes(needle);
    });
  }, [clips, filter, query]);

  const totalBytes = useMemo(() => clips.reduce((sum, c) => sum + (c.bytes ?? 0), 0), [clips]);

  async function openPublish(clip: Clip) {
    try {
      const res = await api.clip(clip.id);
      setPublications(res.publications);
      setPublishTarget(res.clip);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '読み込みに失敗しました', true);
    }
  }

  return (
    <div className="page">
      <h1>書き出したクリップ</h1>
      <p className="sub">
        すべての録画から書き出したクリップ {clips.length} 本・合計 {formatBytes(totalBytes)}。
      </p>

      <div className="row" style={{ marginBottom: 18 }}>
        <div className="aspect-row">
          {FILTERS.map((f) => (
            <button key={f.value} className={`chip ${filter === f.value ? 'on' : ''}`} onClick={() => setFilter(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
        <input
          placeholder="タイトルで絞り込む"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ maxWidth: 260, marginLeft: 'auto' }}
        />
      </div>

      {visible.length === 0 ? (
        <div className="card empty">
          {clips.length === 0 ? 'まだクリップがありません。録画を開いて範囲を書き出してください。' : '該当するクリップがありません。'}
        </div>
      ) : (
        <div className="clip-grid">
          {visible.map((clip) => {
            const badge = STATUS[clip.status];
            return (
              <div className="clip-tile" key={clip.id}>
                <div className="clip-tile-media">
                  {clip.thumbUrl ? (
                    <img src={clip.thumbUrl} alt="" />
                  ) : (
                    <div className="thumb-fallback" style={{ width: 112, height: 112, aspectRatio: 'auto' }}>
                      {clip.status === 'failed' ? '✕' : '…'}
                    </div>
                  )}
                </div>
                <div className="clip-tile-body">
                  <span className="clip-tile-title">
                    <strong>{clip.title}</strong>
                    <span className={badge.className}>{badge.label}</span>
                  </span>
                  <div className="meta-line">
                    {clip.spec.aspect} · {formatDuration(clip.duration)} · {formatBytes(clip.bytes)}
                  </div>
                  <div className="meta-line">
                    {clip.sourceTitle ?? '元の録画は不明'}
                    {clip.recordingId === null && <span className="badge" style={{ marginLeft: 6 }}>録画は削除済み</span>}
                  </div>
                  <div className="meta-line">
                    {formatDateTime(clip.createdAt)} · {formatTimecode(clip.start)}→{formatTimecode(clip.end)}
                  </div>
                  {clip.error && <div className="meta-line" style={{ color: '#ff8b95' }}>{clip.error}</div>}

                  <div className="clip-tile-actions">
                    {clip.status === 'ready' && (
                      <>
                        <button className="small primary" onClick={() => void openPublish(clip)}>
                          書き出し先
                        </button>
                        <a href={clip.downloadUrl ?? '#'}>
                          <button className="small">保存</button>
                        </a>
                        <button
                          className="small"
                          onClick={async () => {
                            onNotify(
                              (await copyText(clip.publicUrl ?? '')) ? '共有リンクをコピーしました' : 'コピーできませんでした',
                            );
                          }}
                        >
                          リンク
                        </button>
                      </>
                    )}
                    {clip.recordingId && (
                      <button className="small ghost" onClick={() => onOpenRecording(clip.recordingId!)}>
                        元の録画へ
                      </button>
                    )}
                    <button
                      className="small danger"
                      onClick={async () => {
                        if (!window.confirm(`「${clip.title}」を削除しますか？`)) return;
                        await api.deleteClip(clip.id);
                        setClips((prev) => prev.filter((c) => c.id !== clip.id));
                        onNotify('クリップを削除しました');
                      }}
                    >
                      削除
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {publishTarget && (
        <PublishDialog
          clip={publishTarget}
          integrations={integrations}
          publications={publications}
          onClose={() => setPublishTarget(null)}
          onNotify={onNotify}
          onPublished={() => void openPublish(publishTarget)}
        />
      )}
    </div>
  );
}
