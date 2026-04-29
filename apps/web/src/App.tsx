import React, { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import BacktestPage from './pages/BacktestPage.js';
import LivePage from './pages/LivePage.js';
import AnalyzePage from './pages/AnalyzePage.js';
import PortfolioPage from './pages/PortfolioPage.js';
import SettingsPage from './pages/SettingsPage.js';
import LoginPage from './pages/LoginPage.js';
import { AuthProvider, useAuth } from './auth/AuthContext.js';
import { api } from './api/client.js';

// Backtest moved to LAST (per user). Default landing → /live since that's the
// trading dashboard most actively used. PM Signal page was removed entirely.
const NAV = [
  { to: '/live',      label: 'Live' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/analyze',   label: 'Analyze' },
  { to: '/settings',  label: 'Settings' },
  { to: '/backtest',  label: 'Backtest' },
];

// Layout (.app-nav / .app-tab / .app-content) lives in src/index.css so it
// can use media queries — inline styles can't. Visual-only styles (userBox,
// logout button, loading splash) stay inline.
const styles: Record<string, React.CSSProperties> = {
  spacer:  { flex: 1, minWidth: 12 },
  userBox: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 12,
             color: '#8b949e', flexShrink: 0 },
  balance: { fontFamily: 'monospace', color: '#3fb950', fontWeight: 600,
             fontVariantNumeric: 'tabular-nums' as const },
  logout:  { padding: '4px 10px', fontSize: 12, borderRadius: 4,
             border: '1px solid #30363d', background: 'transparent',
             color: '#c9d1d9', cursor: 'pointer' },
  loading: { minHeight: '100vh', display: 'flex', alignItems: 'center',
             justifyContent: 'center', background: '#0d1117', color: '#8b949e',
             fontSize: 13 },
};

function AuthedApp() {
  const { user, logout } = useAuth();

  // Poll user's CLOB USDC balance every 30s + on visibility change. Shape:
  //   undefined → still loading (initial)
  //   { ok: true,  value }       → available, render $X.XX in green
  //   { ok: false, reason }      → unavailable / error, render greyed "—" with tooltip
  const [balance, setBalance] = useState<undefined | { ok: true; value: number } | { ok: false; reason: string }>(undefined);
  useEffect(() => {
    let cancelled = false;
    const fetchBal = async () => {
      try {
        const r = await api.getPolyBalance();
        if (cancelled) return;
        setBalance(r.available ? { ok: true, value: r.balance } : { ok: false, reason: r.reason });
      } catch (err) {
        if (!cancelled) setBalance({ ok: false, reason: err instanceof Error ? err.message : 'fetch failed' });
      }
    };
    fetchBal();
    const id = setInterval(fetchBal, 30_000);
    const onVis = () => { if (document.visibilityState === 'visible') fetchBal(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return (
    <>
      <nav className="app-nav">
        {NAV.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `app-tab${isActive ? ' active' : ''}`}
          >
            {label}
          </NavLink>
        ))}
        <div style={styles.spacer} />
        <div style={styles.userBox}>
          {balance === undefined && (
            <span style={{ color: '#6e7681', fontSize: 11 }} title="loading balance...">…</span>
          )}
          {balance && balance.ok === true && (
            <span style={styles.balance} title="USDC collateral on Polymarket CLOB">
              ${balance.value.toFixed(2)}
            </span>
          )}
          {balance && balance.ok === false && (
            <span style={{ color: '#f0a500', fontSize: 11, cursor: 'help' }}
                  title={`Balance unavailable: ${balance.reason}`}>
              ⚠ no balance
            </span>
          )}
          <span>{user?.username}</span>
          <button onClick={logout} style={styles.logout} title="Sign out">Sign out</button>
        </div>
      </nav>
      <div className="app-content">
        <Routes>
          {/* Default landing → /live (most-used page) */}
          <Route path="/"           element={<Navigate to="/live" replace />} />
          <Route path="/backtest/*" element={<BacktestPage />} />
          <Route path="/live"       element={<LivePage />} />
          <Route path="/analyze"    element={<AnalyzePage />} />
          <Route path="/portfolio"  element={<PortfolioPage />} />
          <Route path="/settings"   element={<SettingsPage />} />
          {/* Legacy paths — old bookmarks redirect to live equivalents. */}
          <Route path="/coins"      element={<Navigate to="/settings" replace />} />
          <Route path="/poly"       element={<Navigate to="/live" replace />} />
          <Route path="*"           element={<Navigate to="/live" replace />} />
        </Routes>
      </div>
    </>
  );
}

function Gate() {
  const { loading, user } = useAuth();
  if (loading) return <div style={styles.loading}>Loading…</div>;
  if (!user)   return <LoginPage />;
  return <AuthedApp />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Gate />
      </BrowserRouter>
    </AuthProvider>
  );
}
