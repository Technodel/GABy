import { Link, Outlet, useLocation } from 'react-router-dom';
import { Users, Key, DollarSign, BarChart2, Phone, Settings, LogOut, Menu, X, Flag, CreditCard, Package, Shield } from 'lucide-react';
import { useState } from 'react';

const NAV_ITEMS = [
  { path: '/admin/users', icon: Users, label: 'Users' },
  { path: '/admin/api-keys', icon: Key, label: 'API Keys' },
  { path: '/admin/pricing', icon: DollarSign, label: 'Pricing' },
  { path: '/admin/top-ups', icon: CreditCard, label: 'Top-Ups' },
  { path: '/admin/usage', icon: BarChart2, label: 'Reports' },
  { path: '/admin/feature-flags', icon: Flag, label: 'Feature Flags' },
  { path: '/admin/plan-features', icon: Shield, label: 'Plan Features' },
  { path: '/admin/mcp-marketplace', icon: Package, label: 'MCP Servers' },
  { path: '/admin/contact', icon: Phone, label: 'Contact Info' },
  { path: '/admin/settings', icon: Settings, label: 'Settings' },
];

interface AdminPanelProps {
  onLogout: () => void;
}

export default function AdminPanel({ onLogout }: AdminPanelProps) {
  const location = useLocation();
  const [adminSidebarOpen, setAdminSidebarOpen] = useState(false);

  function closeSidebar() { setAdminSidebarOpen(false); }

  async function handleLogout() {
    await fetch('/admin/logout', { method: 'POST', credentials: 'include' });
    onLogout();
  }

  return (
    <div className="admin-layout" style={{ display: 'flex', height: '100vh', background: 'var(--bg)' }}>
      {/* Mobile overlay */}
      {adminSidebarOpen && (
        <div
          className="sidebar-overlay"
          onClick={closeSidebar}
          style={{
            display: 'none', /* shown on mobile via CSS override in media query */
          }}
        />
      )}

      {/* Sidebar toggle (hamburger) — visible only on mobile */}
      <button
        className="admin-hamburger"
        onClick={() => setAdminSidebarOpen(s => !s)}
        style={{
          display: 'none', /* hidden on desktop */
          position: 'fixed', top: 10, left: 10, zIndex: 201,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)',
          cursor: 'pointer', padding: '8px',
        }}
        title="Toggle sidebar"
      >
        {adminSidebarOpen ? <X size={18} /> : <Menu size={18} />}
      </button>

      {/* Sidebar */}
      <div className={`admin-sidebar${adminSidebarOpen ? ' admin-sidebar-open' : ''}`} style={{
        width: 200,
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        padding: '20px 0',
        flexShrink: 0,
      }}>
        <div style={{ padding: '0 16px 20px', borderBottom: '1px solid var(--border)', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src="/SLOGO.png" alt="SUNy" style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover' }} />
            <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--accent)' }}>SUNy Admin</span>
          </div>
        </div>

        {NAV_ITEMS.map(item => {
          const Icon = item.icon;
          const active = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              onClick={closeSidebar}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 16px',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                background: active ? 'var(--surface)' : 'transparent',
                borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
                textDecoration: 'none',
                fontSize: 14,
                transition: 'all 0.15s',
              }}
            >
              <Icon size={15} />
              {item.label}
            </Link>
          );
        })}

        <div style={{ flex: 1 }} />
        <button
          className="btn btn-secondary btn-sm"
          style={{ margin: '0 12px', justifyContent: 'center' }}
          onClick={handleLogout}
        >
          <LogOut size={13} /> Sign Out
        </button>
      </div>

      {/* Content */}
      <div className="admin-content" style={{ flex: 1, overflow: 'auto', padding: 28 }}>
        <Outlet />
      </div>
    </div>
  );
}
