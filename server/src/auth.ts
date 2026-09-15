import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.ts';

const COOKIE = 'editlive_session';

function sign(value: string): string {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function checkPassword(password: string): boolean {
  return timingSafeEqual(password, config.appPassword);
}

export function issueToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + config.sessionTtlMs })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  if (!timingSafeEqual(signature, sign(payload))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: number };
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.publicUrl.startsWith('https://'),
    maxAge: config.sessionTtlMs,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE, { path: '/' });
}

export function isAuthenticated(req: Request): boolean {
  return verifyToken(req.cookies?.[COOKIE] as string | undefined);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'authentication required' });
}

/** Signed, short-lived state for the OAuth redirect round trip. */
export function issueOauthState(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 10 * 60_000, n: crypto.randomUUID() })).toString(
    'base64url',
  );
  return `${payload}.${sign(payload)}`;
}

export function verifyOauthState(state: string | undefined): boolean {
  return verifyToken(state);
}
