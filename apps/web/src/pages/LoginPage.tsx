/**
 * Login page — the only route accessible when `user` is null in AuthContext.
 * On successful submit, AuthContext sets the user and the router renders the
 * rest of the app.
 */
import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext.js';

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err,      setErr]      = useState<string | null>(null);
  const [busy,     setBusy]     = useState(false);
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => { userRef.current?.focus(); }, []);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setErr(null); setBusy(true);
    try {
      await login(username.trim(), password);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={S.page}>
      <form onSubmit={submit} style={S.card}>
        <div style={S.title}>Trading Bot</div>
        <div style={S.sub}>Admin login</div>

        <label style={S.label}>
          Username
          <input
            ref={userRef}
            type="text"
            autoComplete="username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            disabled={busy}
            style={S.input}
          />
        </label>

        <label style={S.label}>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            disabled={busy}
            style={S.input}
          />
        </label>

        {err && <div style={S.err}>{err}</div>}

        <button
          type="submit"
          disabled={busy || !username || !password}
          style={{
            ...S.btn,
            opacity: (busy || !username || !password) ? 0.6 : 1,
            cursor:  (busy || !username || !password) ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <div style={S.hint}>
          Create an admin user from the server:<br />
          <code style={S.code}>pnpm --filter @trading-bot/api create-admin &lt;user&gt; &lt;pass&gt;</code>
        </div>
      </form>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page:  { minHeight: '100vh', display: 'flex', alignItems: 'center',
           justifyContent: 'center', background: '#0d1117', color: '#c9d1d9',
           padding: 16 },
  // width: 100% lets the card shrink on phones < 360 wide; maxWidth caps it
  // at the original 360 on bigger screens.
  card:  { width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 14,
           padding: 28, background: '#161b22', border: '1px solid #30363d',
           borderRadius: 10, boxShadow: '0 4px 24px rgba(0,0,0,0.4)' },
  title: { fontSize: 22, fontWeight: 700 },
  sub:   { fontSize: 13, color: '#8b949e', marginTop: -6 },
  label: { display: 'flex', flexDirection: 'column', fontSize: 12, color: '#8b949e', gap: 4 },
  input: { padding: '8px 10px', fontSize: 14, borderRadius: 6,
           border: '1px solid #30363d', background: '#0d1117', color: '#c9d1d9' },
  err:   { padding: '6px 10px', fontSize: 12, color: '#f85149',
           background: '#40121a', border: '1px solid #7d1a2a', borderRadius: 6 },
  btn:   { marginTop: 4, padding: '10px 12px', fontSize: 14, fontWeight: 600,
           color: '#fff', background: '#1f6feb', border: 'none', borderRadius: 6 },
  hint:  { fontSize: 11, color: '#6e7681', marginTop: 4, lineHeight: 1.5 },
  code:  { fontSize: 11, background: '#0d1117', padding: '2px 6px',
           borderRadius: 4, border: '1px solid #21262d', display: 'inline-block',
           marginTop: 4 },
};
