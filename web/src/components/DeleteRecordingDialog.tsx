import { useState } from 'react';
import type { Recording } from '../types';
import { formatTimecode } from '../util';

interface DeleteRecordingDialogProps {
  recording: Recording;
  clipCount: number;
  onCancel: () => void;
  onConfirm: (clips: 'delete' | 'keep') => Promise<void> | void;
}

/**
 * Deleting a recording frees the bulk of the disk, but the clips cut from it
 * are finished work that may already be published — so which of the two goes
 * is the operator's call, not a default.
 */
export function DeleteRecordingDialog({ recording, clipCount, onCancel, onConfirm }: DeleteRecordingDialogProps) {
  const [choice, setChoice] = useState<'delete' | 'keep'>(clipCount > 0 ? 'keep' : 'delete');
  const [busy, setBusy] = useState(false);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginBottom: 6 }}>録画を削除</h2>
        <p className="sub" style={{ marginBottom: 18 }}>
          「{recording.title}」（{formatTimecode(recording.duration)}）を削除します。この操作は取り消せません。
        </p>

        {clipCount === 0 ? (
          <p className="hint" style={{ marginTop: 0 }}>
            このセッションから書き出したクリップはありません。
          </p>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            <label className={`choice ${choice === 'keep' ? 'on' : ''}`}>
              <input
                type="radio"
                name="clips"
                checked={choice === 'keep'}
                onChange={() => setChoice('keep')}
              />
              <span>
                <strong>クリップは残す</strong>
                <span className="meta-line">
                  録画した元映像だけを削除します。書き出し済みの {clipCount} 本はそのまま再生・
                  ダウンロード・共有リンクが使えます。元映像が無くなるため、範囲の取り直しはできなくなります。
                </span>
              </span>
            </label>
            <label className={`choice ${choice === 'delete' ? 'on' : ''}`}>
              <input
                type="radio"
                name="clips"
                checked={choice === 'delete'}
                onChange={() => setChoice('delete')}
              />
              <span>
                <strong>クリップも削除する</strong>
                <span className="meta-line">
                  書き出し済みの {clipCount} 本と共有リンクも消えます。ディスクは一番空きます。
                </span>
              </span>
            </label>
          </div>
        )}

        <div className="row" style={{ marginTop: 20, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={busy}>
            キャンセル
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(clipCount === 0 ? 'delete' : choice);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? '削除中…' : '削除する'}
          </button>
        </div>
      </div>
    </div>
  );
}
