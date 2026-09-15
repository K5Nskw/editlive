import { config } from '../config.ts';
import { db } from '../db/index.ts';
import type { ClipRow, PublicationRow, PublishTarget } from '../db/types.ts';
import { enqueueJob } from '../jobs/queue.ts';
import { newId } from '../util/ids.ts';
import { createLogger } from '../util/logger.ts';
import * as buffer from './buffer.ts';
import * as webhook from './webhook.ts';
import * as youtube from './youtube.ts';

const log = createLogger('publish');

export interface YoutubeOptions {
  title?: string;
  description?: string;
  tags?: string[];
  privacyStatus?: 'private' | 'unlisted' | 'public';
}

export interface BufferOptions {
  profileIds?: string[];
  text?: string;
  now?: boolean;
}

export interface WebhookOptions {
  url?: string;
}

export type PublishOptions = YoutubeOptions & BufferOptions & WebhookOptions;

export function clipPublicUrl(clip: ClipRow): string {
  return `${config.publicUrl}/p/${clip.public_token}.mp4`;
}

export function clipThumbnailUrl(clip: ClipRow): string | null {
  return clip.thumb_path ? `${config.publicUrl}/p/${clip.public_token}.jpg` : null;
}

export function createPublication(clipId: string, target: PublishTarget, options: PublishOptions): PublicationRow {
  const clip = db.prepare('SELECT * FROM clips WHERE id = ?').get(clipId) as ClipRow | undefined;
  if (!clip) throw new Error(`clip ${clipId} not found`);
  if (clip.status !== 'ready' || !clip.file_path) throw new Error('the clip has not finished rendering yet');

  const id = newId('pub_');
  const now = Date.now();
  db.prepare(
    `INSERT INTO publications (id, clip_id, target, status, options, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
  ).run(id, clipId, target, JSON.stringify(options), now, now);

  enqueueJob('publish', { publicationId: id });
  return db.prepare('SELECT * FROM publications WHERE id = ?').get(id) as PublicationRow;
}

function update(id: string, fields: Partial<Pick<PublicationRow, 'status' | 'remote_id' | 'remote_url' | 'error'>>): void {
  db.prepare(
    `UPDATE publications SET status = COALESCE(?, status), remote_id = COALESCE(?, remote_id),
     remote_url = COALESCE(?, remote_url), error = ?, updated_at = ? WHERE id = ?`,
  ).run(fields.status ?? null, fields.remote_id ?? null, fields.remote_url ?? null, fields.error ?? null, Date.now(), id);
}

export async function runPublication(publicationId: string, _signal: AbortSignal): Promise<void> {
  const pub = db.prepare('SELECT * FROM publications WHERE id = ?').get(publicationId) as PublicationRow | undefined;
  if (!pub) throw new Error(`publication ${publicationId} not found`);
  const clip = db.prepare('SELECT * FROM clips WHERE id = ?').get(pub.clip_id) as ClipRow | undefined;
  if (!clip?.file_path) throw new Error('the clip file is gone');

  const options = JSON.parse(pub.options) as PublishOptions;
  update(publicationId, { status: 'uploading' });

  try {
    switch (pub.target) {
      case 'youtube': {
        const result = await youtube.uploadVideo({
          file: clip.file_path,
          title: options.title?.trim() || clip.title,
          description: options.description ?? '',
          tags: options.tags,
          privacyStatus: options.privacyStatus ?? 'unlisted',
        });
        update(publicationId, { status: 'done', remote_id: result.id, remote_url: result.url });
        break;
      }
      case 'buffer': {
        const result = await buffer.createUpdate({
          profileIds: options.profileIds ?? [],
          text: options.text ?? clip.title,
          mediaUrl: clipPublicUrl(clip),
          mediaTitle: clip.title,
          mediaDescription: options.text ?? '',
          thumbnailUrl: clipThumbnailUrl(clip) ?? undefined,
          now: options.now ?? false,
        });
        update(publicationId, {
          status: 'done',
          remote_id: result.ids.join(','),
          remote_url: result.url ?? 'https://publish.buffer.com/',
        });
        break;
      }
      case 'webhook': {
        await webhook.deliver(
          {
            clipId: clip.id,
            title: clip.title,
            durationSeconds: clip.duration,
            bytes: clip.bytes,
            mediaUrl: clipPublicUrl(clip),
            thumbnailUrl: clipThumbnailUrl(clip),
            recordingId: clip.recording_id,
            publishedAt: new Date().toISOString(),
          },
          options.url,
        );
        update(publicationId, { status: 'done', remote_url: options.url ?? webhook.webhookConfig().url ?? null });
        break;
      }
      default:
        throw new Error(`unknown publish target "${pub.target}"`);
    }
    log.info(`publication ${publicationId} to ${pub.target} done`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    update(publicationId, { status: 'failed', error: message.slice(0, 1000) });
    throw err;
  }
}

export { buffer, webhook, youtube };
