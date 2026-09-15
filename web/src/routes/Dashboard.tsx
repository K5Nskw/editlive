import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { AppConfig, Recording, Stream } from '../types';
import { copyText, formatBytes, formatDateTime, formatTimecode } from '../util';

interface DashboardProps {
  onOpen: (recordingId: string) => void;
  onNotify: (message: string, error?: boolean) => void;
}

const STATUS_BADGE: Record<Recording['status'], { className: string; label: string }> = {
  live: { className: 'badge live', label: '配信中' },
  processing: { className: 'badge warn', label: '処理中' },
  ready: { className: 'badge ok', label: '編集可' },
  failed: { className: 'badge err', label: '失敗' },
};

export function Dashboard({ onOpen, onNotify }: DashboardProps) {
  const [streams, setStreams] = useState<Stream[]>([]);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [newStream, setNewStream] = useState('');
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const [s, r] = await Promise.all([api.streams(), api.recordings()]);
    setStreams(s.streams);
    setRecordings(r.recordings);
  }, []);

  useEffect(() => {
    api.config().then(setConfig).catch(() => undefined);
  }, []);

  usePolling(load, 5000, true);

  async function copy(value: string) {
    onNotify((await copyText(value)) ? 'コピーしました' : 'コピーできませんでした');
  }

  async function remove(rec: Recording) {
    const clips = rec.clipCount ?? 0;
    const detail = clips > 0 ? `書き出し済みのクリップ ${clips} 本も一緒に消えます。` : '';
    if (!window.confirm(`「${rec.title}」を削除しますか？${detail}この操作は取り消せません。`)) return;
    try {
      await api.deleteRecording(rec.id);
      setRecordings((prev) => prev.filter((r) => r.id !== rec.id));
      onNotify('録画を削除しました');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '削除に失敗しました', true);
    }
  }

  return (
    <div className="page">
      <h1>配信を取り込む</h1>
      <p className="sub">
        OBS などのエンコーダーから下の URL とストリームキーで RTMP 送信すると、自動で録画・解析が始まります。
      </p>

      <div className="stack">
        {streams.map((stream) => (
          <div className="card" key={stream.id}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
              <div className="row tight">
                <h2 style={{ margin: 0 }}>{stream.name}</h2>
                {stream.live ? (
                  <span className="badge live">
                    <i className="pulse" /> 受信中
                  </span>
                ) : (
                  <span className="badge">待機中</span>
                )}
              </div>
              <div className="row tight">
                {stream.live && stream.liveRecordingId && (
                  <button className="small primary" onClick={() => onOpen(stream.liveRecordingId!)}>
                    編集画面を開く
                  </button>
                )}
                <button
                  className="small"
                  onClick={async () => {
                    if (!window.confirm('ストリームキーを再発行しますか？現在のエンコーダー設定は使えなくなります。'))
                      return;
                    await api.rotateKey(stream.id);
                    onNotify('ストリームキーを再発行しました');
                    void load();
                  }}
                >
                  キー再発行
                </button>
                {streams.length > 1 && (
                  <button
                    className="small danger"
                    onClick={async () => {
                      if (!window.confirm(`「${stream.name}」と、その録画をすべて削除しますか？`)) return;
                      await api.deleteStream(stream.id);
                      void load();
                    }}
                  >
                    削除
                  </button>
                )}
              </div>
            </div>

            <div className="ingest-box stack" style={{ gap: 10 }}>
              <div>
                <label>サーバー URL</label>
                {stream.ingest.url ? (
                  <div className="copy-line">
                    <span className="mono">{stream.ingest.url}</span>
                    <button className="small" onClick={() => void copy(stream.ingest.url!)}>
                      コピー
                    </button>
                  </div>
                ) : (
                  <div className="notice">
                    <strong>まだ外部から RTMP を受けられません。</strong>
                    {config?.ingestProblem === 'not-listening' ? (
                      <p>
                        RTMP の待ち受けが起動していません。ポート{' '}
                        <span className="mono">{config.rtmpContainerPort}</span> が他で使われている可能性があります。
                        デプロイのログを確認してください。
                      </p>
                    ) : config?.ingestProblem === 'proxy-port-conflict' ? (
                      <p>
                        TCP Proxy の転送先と Web サーバーがどちらもポート{' '}
                        <span className="mono">{config.httpContainerPort}</span> を使おうとしているため、RTMP は{' '}
                        <span className="mono">{config.rtmpContainerPort}</span> に退避しています。どちらかで直せます
                        — TCP Proxy の転送先を <span className="mono">{config.rtmpContainerPort}</span> に変える、
                        または Web サーバーに専用ポートを与える（<span className="mono">PORT=3000</span> を設定し、
                        HTTP ドメインの target port も 3000 にする）と TCP Proxy は 1935 のままで済みます。
                      </p>
                    ) : (
                      <p>
                        Railway の Settings → Networking で <b>TCP Proxy</b> を追加し、転送先のコンテナポートを{' '}
                        <span className="mono">{config?.rtmpContainerPort ?? 1935}</span> にしてください。発行された
                        ホストとポートがここに表示されます。
                      </p>
                    )}
                    <p className="hint" style={{ marginTop: 6 }}>
                      別の場所で終端している場合は、環境変数 <span className="mono">RTMP_PUBLIC_HOST</span> と{' '}
                      <span className="mono">RTMP_PUBLIC_PORT</span> で直接指定できます。
                    </p>
                  </div>
                )}
              </div>
              <div>
                <label>ストリームキー</label>
                <div className="copy-line">
                  <span className="mono">
                    {revealed[stream.id] ? stream.streamKey : '•'.repeat(stream.streamKey.length)}
                  </span>
                  <button
                    className="small"
                    onClick={() => setRevealed((prev) => ({ ...prev, [stream.id]: !prev[stream.id] }))}
                  >
                    {revealed[stream.id] ? '隠す' : '表示'}
                  </button>
                  <button className="small" onClick={() => void copy(stream.streamKey)}>
                    コピー
                  </button>
                </div>
              </div>
            </div>
            <p className="hint">
              エンコーダー側は <b>H.264 / AAC</b>、<b>キーフレーム間隔 2 秒</b>に設定してください（OBS なら 設定 →
              出力 → 配信）。キーフレーム間隔が長いと、配信中のプレビューが再生できるようになるまで時間がかかるか、
              まったく再生できません。
            </p>
            <p className="hint">
              最大録画時間 {config?.maxRecordingHours ?? 6} 時間。配信を止めてから約 30 秒後に解析が始まります。
            </p>
          </div>
        ))}

        <div className="card">
          <h2>入力を追加</h2>
          <div className="row">
            <input
              placeholder="例）サブカメラ"
              value={newStream}
              onChange={(e) => setNewStream(e.target.value)}
              style={{ maxWidth: 320 }}
            />
            <button
              disabled={!newStream.trim()}
              onClick={async () => {
                await api.createStream(newStream.trim());
                setNewStream('');
                void load();
              }}
            >
              追加
            </button>
          </div>
        </div>
      </div>

      <h1 style={{ marginTop: 34 }}>録画</h1>
      <p className="sub">クリックすると編集画面が開きます。</p>

      <div className="rec-list">
        {recordings.length === 0 && <div className="card empty">まだ録画はありません。</div>}
        {recordings.map((rec) => {
          const badge = STATUS_BADGE[rec.status];
          return (
            <a
              key={rec.id}
              className="rec-item"
              href={`/r/${rec.id}`}
              onClick={(e) => {
                e.preventDefault();
                onOpen(rec.id);
              }}
            >
              {rec.posterUrl ? (
                <img className="rec-thumb" src={rec.posterUrl} alt="" />
              ) : (
                <div className="rec-thumb">no preview</div>
              )}
              <div>
                <div className="row tight">
                  <strong>{rec.title}</strong>
                  <span className={badge.className}>
                    {rec.status === 'live' && <i className="pulse" />}
                    {badge.label}
                  </span>
                </div>
                <div className="meta-line">
                  {formatDateTime(rec.startedAt)} · {formatTimecode(rec.duration)} · {formatBytes(rec.bytes)}
                </div>
              </div>
              <div className="row tight">
                <span className="badge">クリップ {rec.clipCount ?? 0}</span>
                <button
                  className="small danger"
                  disabled={rec.status === 'live'}
                  title={rec.status === 'live' ? '配信中は削除できません' : '録画を削除'}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void remove(rec);
                  }}
                >
                  削除
                </button>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
