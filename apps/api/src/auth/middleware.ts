/**
 * Express middleware: require a valid admin JWT.
 *
 * Token source priority:
 *   1. `Authorization: Bearer <token>` header
 *   2. `?token=<token>` query param — used for SSE (`EventSource` can't set headers)
 *
 * On failure, responds 401 with a concise JSON error.
 * On success, sets `req.adminUser = { id, username }` for downstream handlers.
 */
import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from './authService.js';

/**
 * Attached by `requireAuth` middleware after successful token verification.
 * Read via `(req as AuthedRequest).adminUser`.
 */
export interface AuthedRequest extends Request {
  adminUser: { id: number; username: string };
}

function extractToken(req: Request): string | null {
  const auth = req.header('authorization') ?? req.header('Authorization');
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1];
  }
  const q = req.query['token'];
  if (typeof q === 'string' && q.length > 0) return q;
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'missing token' });
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'invalid or expired token' });
    return;
  }
  const id = Number(payload.sub);
  if (!Number.isFinite(id)) {
    res.status(401).json({ error: 'invalid token payload' });
    return;
  }
  (req as AuthedRequest).adminUser = { id, username: payload.username };
  next();
}
