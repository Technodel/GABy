import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import Login from './pages/Login';
import BridgeSetup from './pages/BridgeSetup';
import Chat from './pages/Chat';
import UserSettings from './pages/UserSettings';
import About from './pages/About';
import ContactUs from './pages/ContactUs';
import AdminPanel from './pages/AdminPanel';
import AdminUsers from './pages/AdminUsers';
import AdminApiKeys from './pages/AdminApiKeys';
import AdminPricing from './pages/AdminPricing';
import AdminUsageStats from './pages/AdminUsageStats';
import AdminSettings from './pages/AdminSettings';
import AdminContactInfo from './pages/AdminContactInfo';

type AuthState = 'loading' | 'user' | 'admin' | 'none';

function AppRoutes() {
  const [auth, setAuth] = useState<AuthState>('loading');
  const [showSettings, setShowSettings] = useState(false);
  const navigate = useNavigate();

  useEffect(() => { checkAuth(); }, []);

  async function checkAuth() {
    // Check user auth
    const res = await fetch('/api/me', { credentials: 'include' });
    if (res.ok) {
      setAuth('user');
      return;
    }
    // Check admin auth
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
      <Route path="/login" element={auth === 'none' ? <Login onLogin={(role) => { setAuth(role as AuthState); navigate(role === 'admin' ? '/admin/users' : '/'); }} /> : <Navigate to={auth === 'admin' ? '/admin/users' : '/'} />} />
      <Route path="/about" element={<About />} />
      <Route path="/contact" element={<ContactUs />} />

      {/* User routes */}
      <Route path="/" element={
        auth === 'none' ? <Navigate to="/login" /> :
        auth === 'admin' ? <Navigate to="/admin/users" /> :
        showSettings
          ? <UserSettings onBack={() => setShowSettings(false)} onLogout={handleLogout} />
          : <Chat
              onLogout={handleLogout}
              onOpenSettings={() => setShowSettings(true)}
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
