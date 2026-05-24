import { useEffect, useRef, useState } from 'react';
import { Home, Eraser, BarChart2, HelpCircle, Settings, Phone, LogOut, Ticket } from 'lucide-react';
import BalanceBadge from './BalanceBadge';
import BridgeStatusBadge from './BridgeStatusBadge';
import ModeSelector from './ModeSelector';
import type { Mode, Project, ProjectSpend } from '../types';

interface TopBarProps {
  userData: { id: number; username: string; balance: number; wallet_balance: number; wallet_auto_spend: boolean; selected_mode: string; max_tokens_per_session?: number | null; cross_device_memory_enabled?: boolean; chat_show_technical_details?: boolean; bridge_connected: boolean; modes: Mode[] } | null;
  activeProject: Project | null;
  activeSpend: ProjectSpend | null;
  balance: number;
  walletBalance: number;
  selectedMode: string;
  modes: Mode[];
  noBalance: boolean;
  routingReason: string | null;
  resolvedMode: string;
  bridgeConnected: boolean;
  sessLimit: number | null;
  sessUsed: number;
  messagesLength: number;
  toggleSidebar: () => void;
  changeMode: (mode: string) => void;
  clearChat: () => void;
  onOpenSettings: (section?: string, notice?: string) => void;
  navigate: (path: string) => void;
  handleLogout: () => void;
  setShowBridgeTip: React.Dispatch<React.SetStateAction<boolean>>;
  setShowUsage: (v: boolean) => void;
  loadUsageStats: (days: number) => void;
  usageDays: number;
  setShowHelp: React.Dispatch<React.SetStateAction<boolean>>;
  isMobile?: boolean;
  uiTheme: string;
  setUiTheme: (t: string) => void;
}

function routingIcon(mode: string): string {
  const icons: Record<string, string> = {
    'free': '💰', 'fast': '⚡', 'smart': '🚀', 'pro': '⭐',
  };
  return icons[mode] ?? '⚙️';
}

function formatSpend(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(6)}`;
}

export default function TopBar(props: TopBarProps) {
  const {
    userData, activeProject, activeSpend, balance, walletBalance,
    selectedMode, modes, noBalance, routingReason, resolvedMode,
    bridgeConnected, sessLimit, sessUsed, messagesLength,
    toggleSidebar, changeMode, clearChat, onOpenSettings, navigate,
    handleLogout, setShowBridgeTip, setShowUsage, loadUsageStats, usageDays, setShowHelp,
    isMobile, uiTheme, setUiTheme,
  } = props;

  const normalizedRouting = (routingReason || '').trim().toLowerCase();
  const showRoutingBadge = Boolean(
    routingReason && normalizedRouting && normalizedRouting !== selectedMode.toLowerCase() && normalizedRouting !== 'auto'
  );
  const topbarRef = useRef<HTMLDivElement | null>(null);
  const [isCompactHeader, setIsCompactHeader] = useState(false);

  useEffect(() => {
    const updateLayout = () => {
      const width = topbarRef.current?.offsetWidth ?? window.innerWidth;
      setIsCompactHeader(width < 1280);
    };

    updateLayout();
    window.addEventListener('resize', updateLayout);
    const observer = typeof ResizeObserver !== 'undefined' && topbarRef.current
      ? new ResizeObserver(updateLayout)
      : null;
    if (observer && topbarRef.current) observer.observe(topbarRef.current);
    return () => {
      window.removeEventListener('resize', updateLayout);
      observer?.disconnect();
    };
  }, []);

  const stackHeader = Boolean(isMobile || isCompactHeader);

  return (
    <div ref={topbarRef} className="topbar" style={{
      display: 'flex',
      flexDirection: stackHeader ? 'column' : 'row',
      alignItems: stackHeader ? 'stretch' : 'center',
      justifyContent: 'space-between',
      padding: stackHeader ? '8px 12px' : '0 16px',
      minHeight: 52,
      borderBottom: '1px solid var(--border)', gap: 8, flexShrink: 0,
    }}>
      {/* LEFT: brand + username + active project */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden',
        flex: stackHeader ? '1 1 auto' : '1',
        justifyContent: stackHeader ? 'space-between' : 'flex-start',
      }}>
        <button
          className="sidebar-toggle-btn"
          onClick={toggleSidebar}
          style={{
            display: 'none', background: 'none', border: 'none', color: 'var(--text-secondary)',
            cursor: 'pointer', padding: '4px', flexShrink: 0,
          }}
          title="Toggle sidebar"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <img src="/SLOGO.png" alt="SUNy" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
        <span className="suny-logo" style={{ fontWeight: 700, fontSize: 16, color: 'var(--accent)', marginRight: 2 }}>SUNy</span>
        <span className="topbar-tagline" style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', opacity: 0.75, whiteSpace: 'nowrap' }}>Consider it done.</span>
        {userData?.username && (
          <span className="topbar-username" style={{
            fontSize: 11, color: 'var(--text-secondary)', background: 'var(--surface)',
            border: '1px solid var(--border)', borderRadius: 999, padding: '2px 8px',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 120,
          }} title={userData.username}>
            {userData.username}
          </span>
        )}
        {activeProject && (
          <span style={{ color: 'var(--text-secondary)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {activeProject.name}</span>
        )}
        {activeSpend && (
          <span style={{ color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap', display: 'none' }}>· {formatSpend(activeSpend.total_cost)}</span>
        )}
      </div>

      {/* CENTER: Mode selector + routing badge */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, pointerEvents: 'auto',
        flexWrap: 'wrap', justifyContent: 'center',
        flex: stackHeader ? '1 1 auto' : '0 1 auto',
        order: stackHeader ? 2 : undefined,
      }}>
        {modes.length > 0 && (
          <ModeSelector modes={modes} selected={selectedMode} onChange={changeMode} noBalance={noBalance} />
        )}
        {showRoutingBadge && (
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px',
              background: 'rgba(108,99,255,0.08)', border: '1px solid rgba(108,99,255,0.2)',
              borderRadius: 6, fontSize: 11, color: 'var(--accent)', cursor: 'pointer',
            }}
            title={routingReason}
          >
            <span>{routingIcon(resolvedMode)}</span>
            <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {routingReason}
            </span>
          </div>
        )}
      </div>

      {/* RIGHT: action buttons */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, minWidth: 0,
        flex: stackHeader ? '1 1 auto' : '1',
        justifyContent: 'flex-end',
        flexWrap: 'nowrap',
      }}>
        {activeProject && (
          <button
            className="btn btn-icon btn-secondary"
            onClick={() => { clearChat(); }} title="Home - back to global chat"
          >
            <Home size={15} />
          </button>
        )}
        {messagesLength > 0 && (
          <button className="btn btn-icon btn-secondary" onClick={clearChat} title="Clear chat">
            <Eraser size={15} />
          </button>
        )}
        {!isMobile && (
          <BridgeStatusBadge connected={bridgeConnected} onClick={async () => {
            if (bridgeConnected) {
              if (!confirm('🔌 Disconnect the SUNy Bridge?\n\nSUNy will no longer be able to read/write files or run commands on your machine. You can reconnect by clicking the bridge button again.')) return;
              try {
                await fetch('/api/bridge/disconnect', { method: 'POST', credentials: 'include' });
              } catch { /* ignore */ }
            }
            setShowBridgeTip(t => !t);
          }} />
        )}
        {isMobile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginRight: 4 }}>
            {['matrix', 'pro', 'suny'].map(t => (
              <button
                key={t}
                onClick={() => {
                  setUiTheme(t);
                  localStorage.setItem('suny_ui_theme', t);
                  localStorage.setItem('suny_dark_mode', String(t === 'matrix'));
                  document.body.classList.remove('theme-matrix', 'theme-pro', 'theme-suny', 'light-mode');
                  document.documentElement.classList.remove('theme-matrix', 'theme-pro', 'theme-suny');
                  if (t === 'pro') document.body.classList.add('theme-pro');
                  else if (t === 'suny') document.body.classList.add('theme-suny');
                  else document.body.classList.add('theme-matrix');
                }}
                style={{
                  background: uiTheme === t ? 'var(--accent)' : 'var(--surface)',
                  border: `1px solid ${uiTheme === t ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 4, cursor: 'pointer', padding: '2px 6px',
                  fontSize: 10, fontWeight: 600, color: uiTheme === t ? '#000' : 'var(--text-muted)',
                  lineHeight: '1.5',
                }}
                title={`${t.charAt(0).toUpperCase() + t.slice(1)} theme`}
              >
                {t === 'matrix' ? '🌐' : t === 'pro' ? '⚪' : '🌙'}
              </button>
            ))}
          </div>
        )}
        <BalanceBadge
          balance={balance} walletBalance={walletBalance}
          remainingTokens={sessLimit == null ? null : Math.max(0, sessLimit - sessUsed)}
          onOpenWalletSettings={() => onOpenSettings('wallet', 'Opened Wallet Transfer in Settings')}
        />
        {!isMobile && (
          <button className="btn btn-icon btn-secondary" onClick={() => { setShowUsage(true); loadUsageStats(usageDays); }} title="Usage stats">
            <BarChart2 size={15} />
          </button>
        )}
        {!isMobile && (
          <button className="btn btn-icon btn-secondary" onClick={() => setShowHelp(true)} title="Keyboard shortcuts & help">
            <HelpCircle size={15} />
          </button>
        )}
        <button className="btn btn-icon btn-secondary" onClick={() => onOpenSettings()} title="Settings">
          <Settings size={15} />
        </button>
        <button className="btn btn-icon btn-secondary" onClick={() => navigate('/client-tickets')} title="Client Tickets">
          <Ticket size={15} />
        </button>
        {!isMobile && (
          <button className="btn btn-icon btn-secondary" onClick={() => navigate('/contact')} title="Contact Us">
            <Phone size={15} />
          </button>
        )}
        <button className="btn btn-icon btn-secondary" onClick={handleLogout} title="Sign out">
          <LogOut size={15} />
        </button>
      </div>
    </div>
  );
}
