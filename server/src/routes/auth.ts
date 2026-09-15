import { Router } from 'express';
import { z } from 'zod';
import { checkPassword, clearSessionCookie, isAuthenticated, issueToken, setSessionCookie } from '../auth.ts';

export const authRouter: Router = Router();

const loginBody = z.object({ password: z.string().min(1) });

authRouter.get('/me', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

authRouter.post('/login', (req, res) => {
  const parsed = loginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'password is required' });
    return;
  }
  if (!checkPassword(parsed.data.password)) {
    res.status(401).json({ error: 'パスワードが違います' });
    return;
  }
  setSessionCookie(res, issueToken());
  res.json({ authenticated: true });
});

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ authenticated: false });
});
