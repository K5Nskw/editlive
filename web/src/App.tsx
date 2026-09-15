import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useRoute, useToast } from './hooks';
import { Dashboard } from './routes/Dashboard';
import { Editor } from './routes/Editor';
import { Login } from './routes/Login';
import { Settings } from './routes/Settings';
import type { Integrations } from './types';

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [path, navigate] = useRoute();
  const [toast, notify] = useToast();
  const [integrations, setIntegrations] = useState<Integrations | null>(null);

  const loadIntegrations = useCallback(() => {
    api
      .integrations()
      .then(setIntegrations)
      .catch(() => setIntegrations(null));
  }, []);

  useEffect(() => {
    api
      .me()
      .then((res) => setAuthed(res.authenticated))
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    if (authed) loadIntegrations();
  }, [authed, loadIntegrations]);

  if (authed === null) return <div className="login-wrap">読み込み中…</div>;
  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;

  const recordingMatch = /^\/r\/([\w-]+)$/.exec(path);

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          EditLive
        </div>
        <nav>
          <a
            href="/"
            className={path === '/' ? 'active' : ''}
            onClick={(e) => {
              e.preventDefault();
              navigate('/');
            }}
          >
            スタジオ
          </a>
          <a
            href="/settings"
            className={path === '/settings' ? 'active' : ''}
            onClick={(e) => {
              e.preventDefault();
              navigate('/settings');
            }}
          >
            設定
          </a>
        </nav>
        <span className="spacer" />
        <button
          className="ghost"
          onClick={async () => {
            await api.logout();
            setAuthed(false);
          }}
        >
          ログアウト
        </button>
      </header>

      {recordingMatch ? (
        <Editor
          recordingId={recordingMatch[1]!}
          integrations={integrations}
          onNotify={notify}
          onBack={() => navigate('/')}
        />
      ) : path === '/settings' ? (
        <Settings integrations={integrations} reload={loadIntegrations} onNotify={notify} />
      ) : (
        <Dashboard onOpen={(id) => navigate(`/r/${id}`)} onNotify={notify} />
      )}

      {toast && <div className={`toast ${toast.error ? 'error' : ''}`}>{toast.message}</div>}
    </>
  );
}
