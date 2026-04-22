import React from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import BacktestPage from './pages/BacktestPage.js';
import LivePage from './pages/LivePage.js';
import PolySignalPage from './pages/PolySignalPage.js';
import AnalyzePage from './pages/AnalyzePage.js';
import PortfolioPage from './pages/PortfolioPage.js';
import SettingsPage from './pages/SettingsPage.js';
import CoinsPage from './pages/CoinsPage.js';

const NAV = [
  { to: '/backtest',  label: 'Backtest' },
  { to: '/live',      label: 'Live' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/poly',      label: 'PM Signal' },
  { to: '/analyze',   label: 'Analyze' },
  { to: '/coins',     label: 'Coins' },
  { to: '/settings',  label: 'Settings' },
];

const styles: Record<string, React.CSSProperties> = {
  nav: {
    display:      'flex',
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
};

export default function App() {
  return (
    <BrowserRouter>
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
      </nav>
      <div style={styles.content}>
        <Routes>
          <Route path="/"           element={<Navigate to="/backtest" replace />} />
          <Route path="/backtest/*" element={<BacktestPage />} />
          <Route path="/live"       element={<LivePage />} />
          <Route path="/poly"       element={<PolySignalPage />} />
          <Route path="/analyze"    element={<AnalyzePage />} />
          <Route path="/portfolio"  element={<PortfolioPage />} />
          <Route path="/coins"      element={<CoinsPage />} />
          <Route path="/settings"   element={<SettingsPage />} />
          <Route path="*"           element={<Navigate to="/backtest" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
