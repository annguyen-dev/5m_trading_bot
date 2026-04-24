/**
 * Auth HTTP endpoints for the dashboard.
 *
 *   POST /api/auth/login  — username+password → JWT (public)
 *   GET  /api/auth/me     — verify token, return user info (protected; middleware
 *                           will reject missing/invalid tokens before we run)
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { signToken, verifyPassword } from '../auth/authService.js';
import { findAdminByUsername, findAdminById, markLastLogin } from '../auth/adminRepo.js';
import type { AuthedRequest } from '../auth/middleware.js';

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
}).strict();

export async function loginHandler(req: Request, res: Response): Promise<void> {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }
  const { username, password } = parsed.data;

  // Constant-time-ish: still verify even if user missing, to reduce timing
  // signal. Throw away result, return generic error.
  const user = await findAdminByUsername(username);
  const ok = user ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !ok) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }

  const token = signToken({ userId: user.id, username: user.username });
  await markLastLogin(user.id).catch(() => { /* non-fatal */ });

  res.json({
    token,
    user: { id: user.id, username: user.username },
  });
}

export async function meHandler(req: Request, res: Response): Promise<void> {
  const ctx = (req as AuthedRequest).adminUser;
  if (!ctx) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  // Verify the user still exists (could have been deleted since token was issued).
  const user = await findAdminById(ctx.id);
  if (!user) {
    res.status(401).json({ error: 'user no longer exists' });
    return;
  }
  res.json({
    user: {
      id:            user.id,
      username:      user.username,
      created_at:    user.created_at,
      last_login_at: user.last_login_at,
    },
  });
}
