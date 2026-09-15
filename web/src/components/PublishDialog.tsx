import { useEffect, useState } from 'react';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { BufferProfile, Clip, Integrations, Publication } from '../types';
import { copyText, formatBytes, formatDuration } from '../util';

interface PublishDialogProps {
  clip: Clip;
  integrations: Integrations | null;
  publications: Publication[];
  onClose: () => void;
  onNotify: (message: string, error?: boolean) => void;
  /** Re-reads the clip so the history below reflects the upload's progress. */
  onPublished: () => void;
}

type Tab = 'download' | 'youtube' | 'buffer' | 'webhook';

export function PublishDialog({ clip, integrations, publications, onClose, onNotify, onPublished }: PublishDialogProps) {
  const [tab, setTab] = useState<Tab>('download');
  const [busy, setBusy] = useState(false);

  const [ytTitle, setYtTitle] = useState(clip.title);
  const [ytDescription, setYtDescription] = useState('');
  const [ytTags, setYtTags] = useState('');
  const [ytPrivacy, setYtPrivacy] = useState<'private' | 'unlisted' | 'public'>('unlisted');

  const [profiles, setProfiles] = useState<BufferProfile[]>([]);
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([]);
  const [bufferText, setBufferText] = useState(clip.title);
  const [bufferNow, setBufferNow] = useState(false);

  // An upload keeps running server side, so the history needs refreshing.
  usePolling(
    onPublished,
    2500,
    publications.some((p) => p.status === 'queued' || p.status === 'uploading'),
  );

  useEffect(() => {
    if (tab !== 'buffer' || !integrations?.buffer.connected) return;
    api
      .bufferProfiles()
      .then((res) => setProfiles(res.profiles))
      .catch((err: Error) => onNotify(err.message, true));
  }, [tab, integrations?.buffer.connected, onNotify]);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await action();
      onNotify(done);
      onPublished();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '配信に失敗しました', true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ margin: 0 }}>{clip.title} を書き出す</h2>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="tabs">
          <button className={tab === 'download' ? 'on' : ''} onClick={() => setTab('download')}>
            保存 / 共有
          </button>
          <button className={tab === 'youtube' ? 'on' : ''} onClick={() => setTab('youtube')}>
            YouTube
          </button>
          <button className={tab === 'buffer' ? 'on' : ''} onClick={() => setTab('buffer')}>
            Buffer
          </button>
          <button className={tab === 'webhook' ? 'on' : ''} onClick={() => setTab('webhook')}>
            Webhook
          </button>
        </div>

        {tab === 'download' && (
          <div className="stack">
            <dl className="kv">
              <dt>長さ</dt>
              <dd>{formatDuration(clip.duration)}</dd>
              <dt>サイズ</dt>
              <dd>{formatBytes(clip.bytes)}</dd>
              <dt>形式</dt>
              <dd>
                MP4 (H.264 / AAC) · {clip.spec.aspect} · {clip.spec.resolution}p
              </dd>
            </dl>
            <a className="primary" href={clip.downloadUrl ?? '#'} style={{ textDecoration: 'none' }}>
              <button className="primary" style={{ width: '100%' }}>
                MP4 をダウンロード
              </button>
            </a>
            <div>
              <label>公開リンク（Buffer や Webhook から参照されます）</label>
              <div className="copy-line">
                <span className="mono">{clip.publicUrl}</span>
                <button
                  className="small"
                  onClick={async () => {
                    onNotify((await copyText(clip.publicUrl ?? '')) ? 'コピーしました' : 'コピーできませんでした');
                  }}
                >
                  コピー
                </button>
              </div>
              <p className="hint">
                このリンクはログイン不要で再生できます。取り消したい場合はクリップを削除してください。
              </p>
            </div>
          </div>
        )}

        {tab === 'youtube' && (
          <div className="stack">
            {!integrations?.youtube.configured && (
              <p className="hint">
                Railway の環境変数に GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET を設定すると有効になります。
              </p>
            )}
            {integrations?.youtube.configured && !integrations.youtube.connected && (
              <p className="hint">設定ページから YouTube アカウントを接続してください。</p>
            )}
            <div className="field">
              <label>タイトル</label>
              <input value={ytTitle} onChange={(e) => setYtTitle(e.target.value)} maxLength={100} />
            </div>
            <div className="field">
              <label>説明</label>
              <textarea value={ytDescription} onChange={(e) => setYtDescription(e.target.value)} />
            </div>
            <div className="grid-2">
              <div className="field">
                <label>タグ（カンマ区切り）</label>
                <input value={ytTags} onChange={(e) => setYtTags(e.target.value)} placeholder="ハイライト, 試合" />
              </div>
              <div className="field">
                <label>公開範囲</label>
                <select value={ytPrivacy} onChange={(e) => setYtPrivacy(e.target.value as typeof ytPrivacy)}>
                  <option value="private">非公開</option>
                  <option value="unlisted">限定公開</option>
                  <option value="public">公開</option>
                </select>
              </div>
            </div>
            <button
              className="primary"
              disabled={busy || !integrations?.youtube.connected}
              onClick={() =>
                run(
                  () =>
                    api.publishClip(clip.id, 'youtube', {
                      title: ytTitle,
                      description: ytDescription,
                      tags: ytTags
                        .split(',')
                        .map((t) => t.trim())
                        .filter(Boolean),
                      privacyStatus: ytPrivacy,
                    }),
                  'YouTube へのアップロードを開始しました',
                )
              }
            >
              YouTube にアップロード
            </button>
          </div>
        )}

        {tab === 'buffer' && (
          <div className="stack">
            {!integrations?.buffer.connected ? (
              <p className="hint">設定ページで Buffer のアクセストークンを登録してください。</p>
            ) : (
              <>
                <div className="field">
                  <label>投稿するプロフィール</label>
                  <div className="aspect-row">
                    {profiles.length === 0 && <span className="hint">読み込み中…</span>}
                    {profiles.map((p) => (
                      <button
                        key={p.id}
                        className={`chip ${selectedProfiles.includes(p.id) ? 'on' : ''}`}
                        onClick={() =>
                          setSelectedProfiles((prev) =>
                            prev.includes(p.id) ? prev.filter((id) => id !== p.id) : [...prev, p.id],
                          )
                        }
                      >
                        {p.service} / {p.username}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label>本文</label>
                  <textarea value={bufferText} onChange={(e) => setBufferText(e.target.value)} />
                </div>
                <label className="row tight" style={{ marginBottom: 0 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={bufferNow}
                    onChange={(e) => setBufferNow(e.target.checked)}
                  />
                  キューに入れずにすぐ投稿する
                </label>
                <p className="hint">
                  Buffer の API は動画ファイルの直接アップロードに対応していないため、クリップの公開リンクを
                  添付した投稿として送信されます。
                </p>
                <button
                  className="primary"
                  disabled={busy || selectedProfiles.length === 0}
                  onClick={() =>
                    run(
                      () =>
                        api.publishClip(clip.id, 'buffer', {
                          profileIds: selectedProfiles,
                          text: bufferText,
                          now: bufferNow,
                        }),
                      'Buffer に送信しました',
                    )
                  }
                >
                  Buffer に送る
                </button>
              </>
            )}
          </div>
        )}

        {tab === 'webhook' && (
          <div className="stack">
            {integrations?.webhook.url ? (
              <>
                <dl className="kv">
                  <dt>送信先</dt>
                  <dd className="mono">{integrations.webhook.url}</dd>
                  <dt>署名</dt>
                  <dd>{integrations.webhook.hasSecret ? 'HMAC-SHA256 付き' : 'なし'}</dd>
                </dl>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => run(() => api.publishClip(clip.id, 'webhook', {}), 'Webhook に送信しました')}
                >
                  このクリップを通知する
                </button>
              </>
            ) : (
              <p className="hint">設定ページで Webhook の送信先 URL を登録してください。</p>
            )}
          </div>
        )}

        {publications.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <h3>配信履歴</h3>
            <div className="stack" style={{ gap: 6 }}>
              {publications.map((pub) => (
                <div key={pub.id} className="row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
                  <span>
                    <span className={`badge ${pub.status === 'done' ? 'ok' : pub.status === 'failed' ? 'err' : ''}`}>
                      {pub.target}
                    </span>{' '}
                    {pub.error ?? pub.status}
                  </span>
                  {pub.remoteUrl && (
                    <a href={pub.remoteUrl} target="_blank" rel="noreferrer">
                      開く
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
