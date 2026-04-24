/**
 * Auth context + hook. Owns the JWT in localStorage + current user state.
 *
 * Flow:
 *   - On mount: read token from localStorage; if present call /api/auth/me to
 *     verify it's still valid; set `user` to the result (or null if expired).
 *   - On login: call /api/auth/login, store token, set user.
 *   - On logout: clear token + user.
 *   - On any 401 from a subsequent request (handled in api/client), we clear
 *     state so the app redirects to the login page.
 *
 * Token is stored in localStorage so SSE (`EventSource`) can read it and pass
 * as `?token=` query param.
 */
import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react';

export const TOKEN_KEY = 'tb_admin_token';

export interface AuthUser {
  id:             number;
  username:       string;
  created_at?:    number;
  last_login_at?: number | null;
}

interface AuthContextValue {
  loading: boolean;           // initial verification in progress
  user:    AuthUser | null;
  login:   (username: string, password: string) => Promise<void>;
  logout:  () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function getStoredToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function setStoredToken(t: string | null): void {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else   localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore storage failures */ }
}

/** Broadcast "auth cleared" so the fetch wrapper and other parts can react. */
function clearAuthAndReload(): void {
  setStoredToken(null);
  // Force a clean reload to the login page — simplest way to reset every
  // cached hook/state across the app.
  try { window.location.reload(); } catch { /* SSR / test envs */ }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user,    setUser]    = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Initial verify: if we have a token, call /me to ensure it's still valid.
  useEffect(() => {
    let cancelled = false;
    const token = getStoredToken();
    if (!token) { setLoading(false); return; }
    (async () => {
      try {
        const res = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (res.ok) {
          const body = (await res.json()) as { user: AuthUser };
          setUser(body.user);
        } else {
          setStoredToken(null);
        }
      } catch {
        if (!cancelled) setStoredToken(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      let msg = text;
      try { msg = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* plain text */ }
      throw new Error(msg || `login failed (${res.status})`);
    }
    const body = (await res.json()) as { token: string; user: AuthUser };
    setStoredToken(body.token);
    setUser(body.user);
  }, []);

  const logout = useCallback(() => {
    clearAuthAndReload();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ loading, user, login, logout }),
    [loading, user, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Called by api/client on 401 — clears token + forces reload to login. */
export function handleUnauthorized(): void {
  clearAuthAndReload();
}
