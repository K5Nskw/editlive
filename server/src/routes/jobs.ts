import { Router } from 'express';
import { db } from '../db/index.ts';
import type { JobRow } from '../db/types.ts';
import { retryJob } from '../jobs/queue.ts';
import { jobDto } from './serialize.ts';

export const jobsRouter: Router = Router();

jobsRouter.get('/', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const rows = (
    status
      ? db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT 100').all(status)
      : db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100').all()
  ) as JobRow[];
  res.json({ jobs: rows.map(jobDto) });
});

jobsRouter.post('/:id/retry', (req, res) => {
  if (!retryJob(req.params.id)) {
    res.status(409).json({ error: 'failed 状態のジョブだけ再実行できます' });
    return;
  }
  res.status(202).json({ ok: true });
});
