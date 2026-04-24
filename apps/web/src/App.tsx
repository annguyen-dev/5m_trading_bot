import React from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import BacktestPage from './pages/BacktestPage.js';
import LivePage from './pages/LivePage.js';
import PolySignalPage from './pages/PolySignalPage.js';
import AnalyzePage from './pages/AnalyzePage.js';
import PortfolioPage from './pages/PortfolioPage.js';
import SettingsPage from './pages/SettingsPage.js';
import LoginPage from './pages/LoginPage.js';
import { AuthProvider, useAuth } from './auth/AuthContext.js';

const NAV = [
  { to: '/backtest',  label: 'Backtest' },
  { to: '/live',      label: 'Live' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/poly',      label: 'PM Signal' },
  { to: '/analyze',   label: 'Analyze' },
  { to: '/settings',  label: 'Settings' },
];

const styles: Record<string, React.CSSProperties> = {
  nav: {
    display:      'flex',
    alignItems:   'center',
    gap:          4,
    padding:      '12px 16px',
    background:   '#161b22',
    borderBottom: '1px solid #30363d',
  },
  tab: {
    padding:    '6px 16px',
    borderRadius: 6,
    border:     'none',
    cursor:     'pointer',
    fontSize:   14,
    fontWeight: 500,
    background: 'transparent',
    color:      '#8b949e',
    textDecoration: 'none',
    transition: 'all 0.15s',
  },
  tabActive: {
    background: '#1f6feb',
    color:      '#fff',
  },
  content: {
    padding:   20,
    minHeight: 'calc(100vh - 50px)',
  },
  spacer:  { flex: 1 },
  userBox: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: '#8b949e' },
  logout:  { padding: '4px 10px', fontSize: 12, borderRadius: 4,
             border: '1px solid #30363d', background: 'transparent',
             color: '#c9d1d9', cursor: 'pointer' },
  loading: { minHeight: '100vh', display: 'flex', alignItems: 'center',
             justifyContent: 'center', background: '#0d1117', color: '#8b949e',
             fontSize: 13 },
};

function AuthedApp() {
  const { user, logout } = useAuth();
  return (
    <>
      <nav style={styles.nav}>
        {NAV.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            style={({ isActive }) => ({ ...styles.tab, ...(isActive ? styles.tabActive : {}) })}
          >
            {label}
          </NavLink>
        ))}
        <div style={styles.spacer} />
        <div style={styles.userBox}>
          <span>{user?.username}</span>
          <button onClick={logout} style={styles.logout} title="Sign out">Sign out</button>
        </div>
      </nav>
      <div style={styles.content}>
        <Routes>
          <Route path="/"           element={<Navigate to="/backtest" replace />} />
          <Route path="/backtest/*" element={<BacktestPage />} />
          <Route path="/live"       element={<LivePage />} />
          <Route path="/poly"       element={<PolySignalPage />} />
          <Route path="/analyze"    element={<AnalyzePage />} />
          <Route path="/portfolio"  element={<PortfolioPage />} />
          <Route path="/settings"   element={<SettingsPage />} />
          {/* Legacy path — was "Coins". Redirect for bookmarks. */}
          <Route path="/coins"      element={<Navigate to="/settings" replace />} />
          <Route path="*"           element={<Navigate to="/backtest" replace />} />
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
