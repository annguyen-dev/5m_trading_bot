/**
 * Admin user DB access layer.
 */
import { getPool } from '@trading-bot/db';
import { hashPassword } from './authService.js';

export interface AdminUser {
  id:             number;
  username:       string;
  password_hash:  string;
  created_at:     number;
  last_login_at:  number | null;
}

export async function findAdminByUsername(username: string): Promise<AdminUser | null> {
  const { rows } = await getPool().query<AdminUser>(
    `SELECT id, username, password_hash, created_at, last_login_at
       FROM admin_users WHERE username = $1 LIMIT 1`,
    [username],
  );
  return rows[0] ?? null;
}

export async function findAdminById(id: number): Promise<AdminUser | null> {
  const { rows } = await getPool().query<AdminUser>(
    `SELECT id, username, password_hash, created_at, last_login_at
       FROM admin_users WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function createAdmin(username: string, password: string): Promise<AdminUser> {
  const hash = await hashPassword(password);
  const now = Date.now();
  const { rows } = await getPool().query<AdminUser>(
    `INSERT INTO admin_users (username, password_hash, created_at)
     VALUES ($1, $2, $3)
     RETURNING id, username, password_hash, created_at, last_login_at`,
    [username, hash, now],
  );
  return rows[0]!;
}

export async function markLastLogin(id: number): Promise<void> {
  await getPool().query(
    `UPDATE admin_users SET last_login_at = $2 WHERE id = $1`,
    [id, Date.now()],
  );
}
