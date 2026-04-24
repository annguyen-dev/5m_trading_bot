/**
 * Auth service — bcrypt password hashing + JWT signing/verification.
 *
 * Only admin users (see `admin_users` table, migration 026) can authenticate.
 * Tokens are stateless JWTs signed with `JWT_SECRET` from env; expiry default
 * 7 days (configurable via JWT_EXPIRY_DAYS).
 *
 * Security notes:
 *   - JWT_SECRET MUST be set in production. A dev-only default is used when
 *     unset + NODE_ENV !== 'production', with a warning on boot.
 *   - Passwords are bcrypt-hashed with cost 10 (sane default, ~100ms/hash on
 *     modern hardware).
 *   - Tokens contain only {sub: userId, username}; no sensitive data.
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const DEV_SECRET = 'dev-jwt-secret-CHANGE-ME-in-production';

export function getJwtSecret(): string {
  const s = process.env['JWT_SECRET'];
  if (s && s.length >= 16) return s;
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('JWT_SECRET must be set (>= 16 chars) in production');
  }
  return DEV_SECRET;
}

function getExpirySeconds(): number {
  const days = Number(process.env['JWT_EXPIRY_DAYS'] ?? '7');
  const safe = Number.isFinite(days) && days > 0 ? days : 7;
  return Math.floor(safe * 24 * 60 * 60);
}

export interface AdminJwtPayload {
  sub:       string;   // user id as string
  username:  string;
  iat?:      number;
  exp?:      number;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(payload: { userId: number | string; username: string }): string {
  return jwt.sign(
    { sub: String(payload.userId), username: payload.username },
    getJwtSecret(),
    { expiresIn: getExpirySeconds() },
  );
}

/**
 * Verify token. Returns payload on success, null on any failure (bad sig,
 * expired, malformed). Never throws.
 */
export function verifyToken(token: string): AdminJwtPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    if (typeof decoded !== 'object' || decoded === null) return null;
    const p = decoded as AdminJwtPayload;
    if (!p.sub || !p.username) return null;
    return p;
  } catch {
    return null;
  }
}
