import { config } from '../config.ts';
import { db } from '../db/index.ts';
import type { JobRow, JobType } from '../db/types.ts';
import { newId } from '../util/ids.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('jobs');

export interface JobContext {
  jobId: string;
  /** Aborted when the process shuts down, so ffmpeg children die with it. */
  signal: AbortSignal;
}

type Handler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<void>;

const handlers = new Map<JobType, Handler>();
const shutdown = new AbortController();
let running = 0;
let draining = false;
let stopped = false;

export function registerJobHandler(type: JobType, handler: Handler): void {
  handlers.set(type, handler);
}

export function enqueueJob(type: JobType, payload: Record<string, unknown>): string {
  const id = newId('job_');
  const now = Date.now();
  db.prepare(
    `INSERT INTO jobs (id, type, payload, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 0, ?, ?)`,
  ).run(id, type, JSON.stringify(payload), now, now);
  log.info(`queued ${type} job ${id}`);
  setImmediate(drain);
  return id;
}

function nextJob(): JobRow | undefined {
  return db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as
    | JobRow
    | undefined;
}

function markRunning(id: string): boolean {
  // Guard against two drain passes claiming the same row.
  const res = db
    .prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'")
    .run(Date.now(), id);
  return res.changes === 1;
}

async function runJob(job: JobRow): Promise<void> {
  const handler = handlers.get(job.type);
  if (!handler) {
    db.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
      `no handler registered for job type "${job.type}"`,
      Date.now(),
      job.id,
    );
    return;
  }
  const started = Date.now();
  try {
    const payload = JSON.parse(job.payload) as Record<string, unknown>;
    await handler(payload, { jobId: job.id, signal: shutdown.signal });
    db.prepare("UPDATE jobs SET status = 'done', error = NULL, updated_at = ? WHERE id = ?").run(Date.now(), job.id);
    log.info(`${job.type} job ${job.id} done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${(err as { tail?: string }).tail ?? ''}`.trim() : String(err);
    db.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
      message.slice(0, 4000),
      Date.now(),
      job.id,
    );
    log.error(`${job.type} job ${job.id} failed`, message);
  }
}

function drain(): void {
  if (draining || stopped) return;
  draining = true;
  try {
    while (running < config.jobConcurrency) {
      const job = nextJob();
      if (!job || !markRunning(job.id)) break;
      running += 1;
      void runJob(job).finally(() => {
        running -= 1;
        setImmediate(drain);
      });
    }
  } finally {
    draining = false;
  }
}

/** Re-queue jobs that were mid-flight when the process died, then start draining. */
export function startJobRunner(): void {
  const reset = db
    .prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'")
    .run(Date.now());
  if (reset.changes > 0) log.warn(`re-queued ${reset.changes} interrupted job(s)`);
  drain();
}

export function stopJobRunner(): void {
  stopped = true;
  shutdown.abort();
}

export function retryJob(id: string): boolean {
  const res = db
    .prepare("UPDATE jobs SET status = 'queued', error = NULL, updated_at = ? WHERE id = ? AND status = 'failed'")
    .run(Date.now(), id);
  if (res.changes === 1) setImmediate(drain);
  return res.changes === 1;
}
