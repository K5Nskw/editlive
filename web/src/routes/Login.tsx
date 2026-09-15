import { useState } from 'react';
import { api } from '../api';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ログインできませんでした');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 6 }}>
          <span className="brand-dot" />
          EditLive
        </div>
        <p className="sub">RTMP で受けた配信をそのままブラウザで編集・配信するスタジオ。</p>
        <div className="field">
          <label>パスワード</label>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        {error && <p style={{ color: '#ff8b95', fontSize: 13 }}>{error}</p>}
        <button className="primary" style={{ width: '100%', marginTop: 12 }} disabled={busy || !password}>
          {busy ? '確認中…' : 'ログイン'}
        </button>
      </form>
    </div>
  );
}
