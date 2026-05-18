import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import Login from './pages/Login';
import BridgeSetup from './pages/BridgeSetup';
import Chat from './pages/Chat';
import UserSettings from './pages/UserSettings';
import About from './pages/About';
import ContactUs from './pages/ContactUs';
import WhatIsSUNy from './pages/WhatIsSUNy';
import AdminPanel from './pages/AdminPanel';
import AdminUsers from './pages/AdminUsers';
import AdminApiKeys from './pages/AdminApiKeys';
import AdminPricing from './pages/AdminPricing';
import AdminUsageStats from './pages/AdminUsageStats';
import AdminSettings from './pages/AdminSettings';
import AdminContactInfo from './pages/AdminContactInfo';
import AdminFeatureFlags from './pages/AdminFeatureFlags';
import PricingPlans from './pages/PricingPlans';

type AuthState = 'loading' | 'user' | 'admin' | 'none';

// Apply saved theme immediately (before first paint)
function applyTheme(dark: boolean) {
  document.body.classList.toggle('light-mode', !dark);
}
applyTheme(localStorage.getItem('suny_dark_mode') !== 'false');

function AppRoutes() {
  const [auth, setAuth] = useState<AuthState>('loading');
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'general' | 'wallet'>('general');
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => { checkAuth(); }, []);

  async function checkAuth() {
    // Check user auth — also detects admin via jwt role
    const res = await fetch('/api/me', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      setAuth(data.role === 'admin' ? 'admin' : 'user');
      return;
    }
    // Check admin auth (fallback for legacy admin login)
    const adminRes = await fetch('/admin/me', { credentials: 'include' });
    if (adminRes.ok) {
      setAuth('admin');
      return;
    }
    setAuth('none');
  }

  function handleLogout() {
    setAuth('none');
    navigate('/login');
  }

  function handleAdminLogout() {
    setAuth('none');
    navigate('/login');
  }

  if (auth === 'loading') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div className="thinking-indicator">
          <div className="dot" /><div className="dot" /><div className="dot" />
        </div>
      </div>
    );
  }

  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={auth === 'none' ? <Login onLogin={() => { checkAuth(); }} /> : <Navigate to={auth === 'admin' ? '/admin/users' : '/'} />} />
      <Route path="/about" element={<About />} />
      <Route path="/what-is-suny" element={<WhatIsSUNy />} />
      <Route path="/contact" element={<ContactUs />} />
      <Route path="/pricing" element={<PricingPlans />} />
      <Route path="/plans" element={<PricingPlans />} />

      {/* User routes */}
      <Route path="/" element={
        auth === 'none' ? <Navigate to="/login" /> :
        auth === 'admin' ? <Navigate to="/admin/users" /> :
        showSettings
          ? <UserSettings onBack={() => setShowSettings(false)} onLogout={handleLogout} initialSection={settingsSection} initialNotice={settingsNotice} />
          : <Chat
              onLogout={handleLogout}
              onOpenSettings={(section, notice) => {
                setSettingsSection(section ?? 'general');
                setSettingsNotice(notice ?? null);
                setShowSettings(true);
              }}
              onBridgeOffline={() => { /* handled inline by BridgeStatusBadge */ }}
            />
      } />

      {/* Admin routes */}
      <Route path="/admin" element={auth === 'admin' ? <AdminPanel onLogout={handleAdminLogout} /> : <Navigate to="/login" />}>
        <Route index element={<Navigate to="/admin/users" />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="api-keys" element={<AdminApiKeys />} />
        <Route path="pricing" element={<AdminPricing />} />
        <Route path="usage" element={<AdminUsageStats />} />
        <Route path="settings" element={<AdminSettings />} />
        <Route path="contact" element={<AdminContactInfo />} />
        <Route path="feature-flags" element={<AdminFeatureFlags />} />
      </Route>

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
