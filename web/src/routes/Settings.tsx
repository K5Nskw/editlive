import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Integrations } from '../types';

interface SettingsProps {
  integrations: Integrations | null;
  reload: () => void;
  onNotify: (message: string, error?: boolean) => void;
}

export function Settings({ integrations, reload, onNotify }: SettingsProps) {
  const [bufferToken, setBufferToken] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');

  useEffect(() => {
    setWebhookUrl(integrations?.webhook.url ?? '');
  }, [integrations?.webhook.url]);

  // The YouTube OAuth callback redirects back here with the outcome.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('youtube');
    if (!status) return;
    if (status === 'connected') onNotify(`YouTube を接続しました（${params.get('channel') ?? ''}）`);
    else onNotify(`YouTube の接続に失敗しました: ${params.get('message') ?? 'unknown'}`, true);
    window.history.replaceState({}, '', '/settings');
    reload();
  }, [onNotify, reload]);

  async function guard(action: () => Promise<unknown>, done: string) {
    try {
      await action();
      onNotify(done);
      reload();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '失敗しました', true);
    }
  }

  return (
    <div className="page">
      <h1>書き出し先の設定</h1>
      <p className="sub">クリップの配信先を接続します。サーバー保存とダウンロードは設定不要で使えます。</p>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>YouTube</h2>
          {integrations?.youtube.connected ? (
            <span className="badge ok">接続済み {integrations.youtube.channel?.title ?? ''}</span>
          ) : (
            <span className="badge">未接続</span>
          )}
        </div>
        {!integrations?.youtube.configured ? (
          <>
            <p className="hint">
              Railway の環境変数に <span className="mono">GOOGLE_CLIENT_ID</span> と{' '}
              <span className="mono">GOOGLE_CLIENT_SECRET</span> を設定してから再デプロイしてください。
            </p>
            <p className="hint">
              Google Cloud Console の OAuth クライアントには、次のリダイレクト URI を登録します。
            </p>
            <div className="copy-line" style={{ marginTop: 8 }}>
              <span className="mono">{integrations?.youtube.redirectUri}</span>
            </div>
          </>
        ) : (
          <div className="row" style={{ marginTop: 12 }}>
            {integrations.youtube.connected ? (
              <button className="danger" onClick={() => void guard(api.youtubeDisconnect, 'YouTube を切断しました')}>
                接続を解除
              </button>
            ) : (
              <button
                className="primary"
                onClick={async () => {
                  try {
                    const res = await api.youtubeAuthUrl();
                    window.location.href = res.url;
                  } catch (err) {
                    onNotify(err instanceof Error ? err.message : '接続に失敗しました', true);
                  }
                }}
              >
                Google アカウントを接続
              </button>
            )}
            <span className="hint" style={{ marginTop: 0 }}>
              リダイレクト URI: <span className="mono">{integrations.youtube.redirectUri}</span>
            </span>
          </div>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Buffer（SNS 配信）</h2>
          <span className={`badge ${integrations?.buffer.connected ? 'ok' : ''}`}>
            {integrations?.buffer.connected ? '接続済み' : '未接続'}
          </span>
        </div>
        <p className="hint">
          Buffer の開発者ページで発行したアクセストークンを登録すると、X・Facebook・LinkedIn などの
          プロフィールへクリップを投稿できます。
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <input
            type="password"
            placeholder="1/xxxxxxxxxxxxxxxx"
            value={bufferToken}
            onChange={(e) => setBufferToken(e.target.value)}
            style={{ maxWidth: 360 }}
          />
          <button
            disabled={bufferToken.trim().length < 10}
            onClick={() =>
              void guard(async () => {
                await api.saveBufferToken(bufferToken.trim());
                setBufferToken('');
              }, 'Buffer のトークンを保存しました')
            }
          >
            保存
          </button>
          {integrations?.buffer.connected && (
            <button className="danger" onClick={() => void guard(api.clearBuffer, 'Buffer の接続を解除しました')}>
              解除
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Webhook</h2>
          <span className={`badge ${integrations?.webhook.url ? 'ok' : ''}`}>
            {integrations?.webhook.url ? '設定済み' : '未設定'}
          </span>
        </div>
        <p className="hint">
          クリップの公開 URL とメタデータを JSON で POST します。シークレットを設定すると{' '}
          <span className="mono">x-editlive-signature</span> ヘッダーに HMAC-SHA256 が付きます。
        </p>
        <div className="grid-2" style={{ marginTop: 12 }}>
          <div className="field">
            <label>送信先 URL</label>
            <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://" />
          </div>
          <div className="field">
            <label>シークレット（任意）</label>
            <input
              type="password"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder={integrations?.webhook.hasSecret ? '設定済み（変更する場合のみ入力）' : ''}
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            disabled={!webhookUrl.startsWith('http')}
            onClick={() => void guard(() => api.saveWebhook(webhookUrl, webhookSecret || undefined), '保存しました')}
          >
            保存
          </button>
          {integrations?.webhook.url && (
            <button className="danger" onClick={() => void guard(api.clearWebhook, 'Webhook を削除しました')}>
              解除
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
