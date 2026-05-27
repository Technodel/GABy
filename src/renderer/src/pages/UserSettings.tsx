import { useState, useEffect, useMemo, useRef } from 'react';
import { LogOut } from 'lucide-react';
import MemoryManager from '../components/MemoryManager';

interface UserData {
  selected_mode?: string;
  balance?: number;
  wallet_balance?: number;
  wallet_auto_spend?: boolean;
  auto_approve: boolean;
  max_tokens_per_session: number | null;
  display_name: string | null;
  cross_device_memory_enabled?: boolean;
  chat_show_technical_details?: boolean;
  task_interruption_behavior?: string;
  plan?: string;
  plan_features?: Record<string, boolean>;
  upgrade_pending?: boolean;
}

interface PricingMode {
  mode: string;
  input_token_base_cost: number;
  output_token_base_cost: number;
}

interface UserSettingsProps {
  onBack: () => void;
  onLogout: () => void;
  initialSection?: 'general' | 'wallet';
  initialNotice?: string | null;
}

export default function UserSettings({ onBack, onLogout, initialSection = 'general', initialNotice = null }: UserSettingsProps) {
  const [uiTheme, setUiTheme] = useState<'matrix' | 'pro' | 'suny'>(() => {
    try {
      const saved = localStorage.getItem('suny_ui_theme');
      if (saved === 'matrix' || saved === 'pro' || saved === 'suny') return saved;
      return localStorage.getItem('suny_dark_mode') === 'false' ? 'pro' : 'matrix';
    } catch {
      return 'matrix';
    }
  });
  const [autoApprove, setAutoApprove] = useState(true);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [crossDeviceMemoryEnabled, setCrossDeviceMemoryEnabled] = useState(false);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);
  const [taskInterruptionBehavior, setTaskInterruptionBehavior] = useState<'interrupt' | 'queue'>('interrupt');
  const [maxTokens, setMaxTokens] = useState<string>('');
  const [displayName, setDisplayName] = useState('');
  const [companyName, setCompanyName] = useState(() => {
    try { return localStorage.getItem('suny_company_name') || ''; } catch { return ''; }
  });
  const [saved, setSaved] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [companyNameSaved, setCompanyNameSaved] = useState(false);
  const [walletAmount, setWalletAmount] = useState('');
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletMsg, setWalletMsg] = useState('');
  const [walletAutoSpend, setWalletAutoSpend] = useState(false);
  const [walletAutoSpendBusy, setWalletAutoSpendBusy] = useState(false);
  const [selectedMode, setSelectedMode] = useState('fast');
  const [pricingModes, setPricingModes] = useState<PricingMode[]>([]);
  const [balance, setBalance] = useState(0);
  const [walletBalance, setWalletBalance] = useState(0);
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [notifyOnComplete, setNotifyOnComplete] = useState(() => {
    try { return localStorage.getItem('suny_notify_on_complete') === 'true'; } catch { return false; }
  });
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermission | 'unsupported'>(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    return Notification.permission;
  });
  const [budgetGateEnabled, setBudgetGateEnabled] = useState(false);
  const [budgetPerRun, setBudgetPerRun] = useState('');
  const [forecastEnabled, setForecastEnabled] = useState(false);
  const [forecastMarkupMode, setForecastMarkupMode] = useState('');
  const [userPlan, setUserPlan] = useState<string>('regular');
  const [planFeatures, setPlanFeatures] = useState<Record<string, boolean>>({});
  const [upgradePending, setUpgradePending] = useState(false);
  const [soundsEnabled, setSoundsEnabled] = useState(() => {
    try { return localStorage.getItem('suny_sounds_enabled') !== 'false'; } catch { return true; }
  });
  const [visualEffects, setVisualEffects] = useState(() => {
    try { return localStorage.getItem('suny_visual_effects') !== 'false'; } catch { return true; }
  });
  const walletSectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onBack]);

  useEffect(() => {
    fetch('/api/me', { credentials: 'include' })
      .then(r => r.json())
      .then((data: UserData) => {
        setAutoApprove(data.auto_approve ?? true);
        setCrossDeviceMemoryEnabled(Boolean(data.cross_device_memory_enabled));
        setShowTechnicalDetails(Boolean(data.chat_show_technical_details));
        setTaskInterruptionBehavior(data.task_interruption_behavior === 'queue' ? 'queue' : 'interrupt');
        setSelectedMode(data.selected_mode ?? 'fast');
        setBalance(data.balance ?? 0);
        setWalletBalance(data.wallet_balance ?? 0);
        setWalletAutoSpend(Boolean(data.wallet_auto_spend));
        if (data.max_tokens_per_session != null) {
          setMaxTokens(String(data.max_tokens_per_session));
        }
        setDisplayName(data.display_name ?? '');
        setBudgetGateEnabled(Boolean((data as any).budget_gate_enabled));
        setBudgetPerRun(String((data as any).budget_per_run ?? ''));
        setForecastEnabled(Boolean((data as any).forecast_enabled));
        setForecastMarkupMode(String((data as any).forecast_markup_mode ?? ''));
        setUserPlan(data.plan ?? 'regular');
        setPlanFeatures(data.plan_features ?? {});
        setUpgradePending(Boolean(data.upgrade_pending));
      });
    fetch('/api/pricing-public', { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then((data: PricingMode[]) => setPricingModes(Array.isArray(data) ? data : []))
      .catch(() => {});
    const storedTheme = localStorage.getItem('suny_ui_theme');
    if (storedTheme === 'matrix' || storedTheme === 'pro' || storedTheme === 'suny') {
      setUiTheme(storedTheme);
    } else {
      const storedDark = localStorage.getItem('suny_dark_mode');
      if (storedDark !== null) setUiTheme(storedDark === 'false' ? 'pro' : 'matrix');
    }
    const mem = localStorage.getItem('suny_memory_enabled');
    if (mem !== null) setMemoryEnabled(mem !== 'false');
  }, []);

  useEffect(() => {
    if (initialSection !== 'wallet') return;
    setTimeout(() => walletSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
  }, [initialSection]);

  useEffect(() => {
    setNotice(initialNotice);
    if (!initialNotice) return;
    const t = setTimeout(() => setNotice(null), 1800);
    return () => clearTimeout(t);
  }, [initialNotice]);

  const approxTokens = useMemo(() => {
    const amt = parseFloat(walletAmount);
    if (!isFinite(amt) || amt <= 0) return null;
    const mode = pricingModes.find(m => m.mode === selectedMode);
    if (!mode) return null;
    const avgCostPerToken = (mode.input_token_base_cost + mode.output_token_base_cost) / 2;
    if (!isFinite(avgCostPerToken) || avgCostPerToken <= 0) return null;
    return Math.floor(amt / avgCostPerToken);
  }, [walletAmount, pricingModes, selectedMode]);

  async function saveSettings() {
    const parsed = parseInt(maxTokens, 10);
    const settingsRes = await fetch('/api/settings', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dark_mode: uiTheme === 'matrix',
        auto_approve: autoApprove,
        memory_enabled: memoryEnabled,
        cross_device_memory_enabled: crossDeviceMemoryEnabled,
        chat_show_technical_details: showTechnicalDetails,
        max_tokens_per_session: !isNaN(parsed) && parsed > 0 ? parsed : null,
        task_interruption_behavior: taskInterruptionBehavior,
        budget_gate_enabled: budgetGateEnabled,
        budget_per_run: parseFloat(budgetPerRun) > 0 ? parseFloat(budgetPerRun) : 0,
        forecast_enabled: forecastEnabled,
        forecast_markup_mode: forecastMarkupMode.trim() || undefined,
      }),
    });
    if (!settingsRes.ok) return;

    const transferAmount = parseFloat(walletAmount);
    if (isFinite(transferAmount) && transferAmount > 0) {
      if (balance <= 0) {
        setWalletMsg('Main balance is $0.00. Top up main credits first, then transfer to Bot Wallet.');
      } else if (transferAmount > balance) {
        setWalletMsg(`You only have $${balance.toFixed(2)} in main balance. Enter a smaller amount.`);
      } else {
        setWalletBusy(true);
        const transferRes = await fetch('/api/wallet/transfer', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: transferAmount }),
        });
        const transferData = await transferRes.json().catch(() => ({}));
        if (transferRes.ok) {
          setWalletMsg(`Transferred $${transferAmount.toFixed(2)} to Bot Wallet.`);
          setWalletAmount('');
          if (transferData.newBalance !== undefined) setBalance(transferData.newBalance);
          if (transferData.newWalletBalance !== undefined) setWalletBalance(transferData.newWalletBalance);
        } else {
          setWalletMsg(transferData?.error || 'Wallet transfer failed.');
        }
        setWalletBusy(false);
      }
    }

    localStorage.setItem('suny_ui_theme', uiTheme);
    localStorage.setItem('suny_dark_mode', String(uiTheme === 'matrix'));
    document.body.classList.remove('theme-matrix', 'theme-pro', 'theme-suny', 'light-mode');
    if (uiTheme === 'pro') document.body.classList.add('theme-pro');
    else if (uiTheme === 'suny') document.body.classList.add('theme-suny');
    else document.body.classList.add('theme-matrix');
    localStorage.setItem('suny_memory_enabled', String(memoryEnabled));
    localStorage.setItem('suny_sounds_enabled', String(soundsEnabled));
    localStorage.setItem('suny_visual_effects', String(visualEffects));
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  async function saveName() {
    await fetch('/api/me/name', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: displayName.trim() || null }),
    });
    setNameSaved(true);
    setTimeout(() => setNameSaved(false), 2500);
  }

  async function handleLogout() {
    await fetch('/api/logout', { method: 'POST', credentials: 'include' });
    onLogout();
  }

  async function toggleAutoSpend(next: boolean) {
    const prev = walletAutoSpend;
    setWalletAutoSpend(next);
    setWalletAutoSpendBusy(true);
    try {
      const res = await fetch('/api/wallet/auto-spend', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        setWalletAutoSpend(prev);
        const data = await res.json().catch(() => ({}));
        setWalletMsg(data?.error || 'Could not update auto-transfer setting.');
      }
    } catch {
      setWalletAutoSpend(prev);
      setWalletMsg('Could not update auto-transfer setting.');
    } finally {
      setWalletAutoSpendBusy(false);
    }
  }

  async function transferToWallet() {
    const amount = parseFloat(walletAmount);
    if (!isFinite(amount) || amount <= 0) {
      setWalletMsg('Please enter a valid transfer amount.');
      return;
    }
    if (balance <= 0) {
      setWalletMsg('Main balance is $0.00. Top up main credits first, then transfer to Bot Wallet.');
      return;
    }
    if (amount > balance) {
      setWalletMsg(`You only have $${balance.toFixed(2)} in main balance. Enter a smaller amount.`);
      return;
    }
    setWalletBusy(true);
    setWalletMsg('');
    try {
      const res = await fetch('/api/wallet/transfer', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setWalletMsg(data?.error || 'Transfer failed');
        return;
      }
      setWalletMsg('Transfer complete. Bot wallet was updated.');
      setWalletAmount('');
      if (data.newBalance !== undefined) setBalance(data.newBalance);
      if (data.newWalletBalance !== undefined) setWalletBalance(data.newWalletBalance);
    } catch {
      setWalletMsg('Transfer failed. Please try again.');
    } finally {
      setWalletBusy(false);
    }
  }

  const settingsCardStyle: React.CSSProperties = { marginBottom: 14 };
  const splitRowStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: 16,
    alignItems: 'start',
  };
  const stackGapStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 14 };
  const radioOptionStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '18px minmax(0, 1fr)',
    gap: 12,
    alignItems: 'start',
    cursor: 'pointer',
    padding: '2px 0',
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', padding: 24 }}>
      {notice && (
        <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 110, background: 'rgba(16,185,129,0.14)', color: 'var(--success)', border: '1px solid var(--success)', borderRadius: 999, padding: '8px 12px', fontSize: 12, fontWeight: 600 }}>
          {notice}
        </div>
      )}
      <div style={{ maxWidth: 520, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
          <button className="btn btn-secondary btn-sm" onClick={onBack}>← Back</button>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>⚙️ My Settings</h1>
          <button className="btn btn-primary btn-sm" onClick={saveSettings} style={{ marginLeft: 'auto' }}>
            {saved ? '✓ Saved!' : '💾 Save Settings'}
          </button>
        </div>

        <div className="card" style={settingsCardStyle}>
          <h3 style={{ fontWeight: 600, marginBottom: 12 }}>👤 Your Name</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
            Optional — if set, SUNy will call you by name during conversations.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="e.g. Alex"
              maxLength={50}
              style={{ flex: 1 }}
              onKeyDown={e => { if (e.key === 'Enter') saveName(); }}
            />
            <button className="btn btn-primary btn-sm" onClick={saveName}>
              {nameSaved ? '✓ Saved!' : 'Save'}
            </button>
          </div>
        </div>

        <div className="card" style={settingsCardStyle}>
          <h3 style={{ fontWeight: 600, marginBottom: 12 }}>🏢 Company / Personal Name</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
            Required for Client Link feature. This name will be shown to your clients when you send them a ticket link.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={companyName}
              onChange={e => setCompanyName(e.target.value)}
              placeholder="e.g. Acme Corp or John Doe"
              maxLength={100}
              style={{ flex: 1 }}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  localStorage.setItem('suny_company_name', companyName.trim());
                  setCompanyNameSaved(true);
                  setTimeout(() => setCompanyNameSaved(false), 2000);
                }
              }}
            />
            <button className="btn btn-primary btn-sm" onClick={() => {
              localStorage.setItem('suny_company_name', companyName.trim());
              setCompanyNameSaved(true);
              setTimeout(() => setCompanyNameSaved(false), 2000);
            }}>
              {companyNameSaved ? '✓ Saved!' : 'Save'}
            </button>
          </div>
        </div>

        <div className="card" style={settingsCardStyle}>
          <h3 style={{ fontWeight: 600, marginBottom: 16 }}>🎨 Look & Feel</h3>
          <div style={{ ...splitRowStyle, marginBottom: 14 }}>
            <div>
              <div style={{ fontWeight: 500, fontSize: 14 }}>Interface Mode</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Choose between Matrix, SUNY, and Pro</div>
            </div>
            <select
              value={uiTheme}
              onChange={e => {
                const next = e.target.value === 'pro' ? 'pro' : e.target.value === 'suny' ? 'suny' : 'matrix';
                setUiTheme(next);
                localStorage.setItem('suny_ui_theme', next);
                localStorage.setItem('suny_dark_mode', String(next === 'matrix'));
                document.body.classList.remove('theme-matrix', 'theme-pro', 'theme-suny', 'light-mode');
                document.documentElement.classList.remove('theme-matrix', 'theme-pro', 'theme-suny');
                if (next === 'pro') document.body.classList.add('theme-pro');
                else if (next === 'suny') document.body.classList.add('theme-suny');
                else document.body.classList.add('theme-matrix');
                if (next === 'pro') document.documentElement.classList.add('theme-pro');
                else if (next === 'suny') document.documentElement.classList.add('theme-suny');
                else document.documentElement.classList.add('theme-matrix');
              }}
              style={{ maxWidth: 180 }}
            >
              <option value="matrix">Matrix (Dark Green)</option>
              <option value="suny">SUNY (Solar Orange)</option>
              <option value="pro">Pro</option>
            </select>
          </div>
          <div style={{ ...splitRowStyle, marginBottom: 14 }}>
            <div>
              <div style={{ fontWeight: 500, fontSize: 14 }}>🔊 Sound Effects</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Robot/machine sounds on send, receive, and completions</div>
            </div>
            <input type="checkbox" className="toggle" checked={soundsEnabled} onChange={e => setSoundsEnabled(e.target.checked)} style={{ marginTop: 2 }} />
          </div>
          <div style={splitRowStyle}>
            <div>
              <div style={{ fontWeight: 500, fontSize: 14 }}>✨ Visual Effects</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Bubble glow animation while SUNy is working</div>
            </div>
            <input type="checkbox" className="toggle" checked={visualEffects} onChange={e => setVisualEffects(e.target.checked)} style={{ marginTop: 2 }} />
          </div>
        </div>

        <div className="card" style={settingsCardStyle}>
          <div style={splitRowStyle}>
            <div>
              <h3 style={{ fontWeight: 600, marginBottom: 4 }}>✅ Auto-Approve SUNy's Actions</h3>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>
                Let SUNy work freely without asking for confirmation every step —
                it will keep you updated the whole time in plain English.
              </p>
            </div>
            <input
              type="checkbox"
              className="toggle"
              checked={autoApprove}
              onChange={e => setAutoApprove(e.target.checked)}
              style={{ flexShrink: 0, marginTop: 2 }}
            />
          </div>
        </div>

        <div className="card" style={settingsCardStyle}>
          <h3 style={{ fontWeight: 600, marginBottom: 6 }}>🎯 Session Usage Limit</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
            Set a per-session maximum — leave blank to use the global limit.
            Useful if you want to keep tasks short and focused.
          </p>
          <input
            type="number"
            min={1000}
            step={1000}
            value={maxTokens}
            onChange={e => setMaxTokens(e.target.value)}
            placeholder="Blank = use global default"
            style={{ maxWidth: 280 }}
          />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
            Controls how much work SUNy can do in one conversation before pausing.
          </div>
        </div>

        <div className="card" style={settingsCardStyle}>
          <div style={{ ...splitRowStyle, marginBottom: 10 }}>
            <div>
              <h3 style={{ fontWeight: 600, marginBottom: 4 }}>🧠 SUNy's Memory</h3>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>
                Add notes that SUNy always keeps in mind — like how you like your code,
                or things you want it to always or never do.
              </p>
            </div>
            <input
              type="checkbox"
              className="toggle"
              checked={memoryEnabled}
              onChange={e => setMemoryEnabled(e.target.checked)}
              style={{ flexShrink: 0, marginTop: 2 }}
            />
          </div>
          {memoryEnabled && <MemoryManager />}
        </div>

        <div className="card" style={settingsCardStyle}>
          <div style={splitRowStyle}>
            <div>
              <h3 style={{ fontWeight: 600, marginBottom: 4 }}>🌍 Cross-Device Memory Persistence</h3>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>
                Sync your project chat history and project memories across devices.
              </p>
            </div>
            <input
              type="checkbox"
              className="toggle"
              checked={crossDeviceMemoryEnabled}
              onChange={e => setCrossDeviceMemoryEnabled(e.target.checked)}
              style={{ flexShrink: 0, marginTop: 2 }}
            />
          </div>
          {crossDeviceMemoryEnabled && (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--warning)', lineHeight: 1.5 }}>
              Privacy notice: when this is enabled, your data is stored privately in your account database on our server, not only in your browser local storage.
            </div>
          )}
        </div>

        <div className="card" style={settingsCardStyle}>
          <div style={splitRowStyle}>
            <div>
              <h3 style={{ fontWeight: 600, marginBottom: 4 }}>🧩 Show Technical Details In Chat</h3>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>
                Keep this OFF for beginner mode (friendly, code-free task updates). Turn ON to show prompts, code blocks, and shell commands.
              </p>
            </div>
            <input
              type="checkbox"
              className="toggle"
              checked={showTechnicalDetails}
              onChange={e => setShowTechnicalDetails(e.target.checked)}
              style={{ flexShrink: 0, marginTop: 2 }}
            />
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            OFF = beginner-friendly responses. ON = full technical visibility.
          </div>
        </div>

        <div className="card" style={settingsCardStyle}>
          <h3 style={{ fontWeight: 600, marginBottom: 10 }}>🔄 Task Interruption Behavior</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>
            When you send a new prompt while SUNy is already working on a task, what should happen?
          </p>
          <div style={stackGapStyle}>
          <label style={radioOptionStyle}>
            <input
              type="radio"
              name="task_interruption"
              checked={taskInterruptionBehavior === 'interrupt'}
              onChange={() => setTaskInterruptionBehavior('interrupt')}
              style={{ marginTop: 3 }}
            />
            <div>
              <div style={{ fontWeight: 500, fontSize: 14 }}>⚡ Interrupt current task</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                SUNy stops the current run and immediately follows your latest request. Context is preserved, so edits/additions/corrections are treated as updates to the same task.
              </div>
            </div>
          </label>
          <label style={radioOptionStyle}>
            <input
              type="radio"
              name="task_interruption"
              checked={taskInterruptionBehavior === 'queue'}
              onChange={() => setTaskInterruptionBehavior('queue')}
              style={{ marginTop: 3 }}
            />
            <div>
              <div style={{ fontWeight: 500, fontSize: 14 }}>📋 Queue after current task</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                SUNy finishes what it's doing first, then processes your new request right after.
              </div>
            </div>
          </label>
          </div>
        </div>

        <div
          ref={walletSectionRef}
          className="card"
          style={{ marginBottom: 14, borderColor: initialSection === 'wallet' ? 'var(--success)' : 'var(--border)' }}
        >
          <h3 style={{ fontWeight: 600, marginBottom: 8 }}>💳 Bot Wallet Transfer</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
            Move credits from your main balance into the Bot Wallet used for SUNy task execution.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={walletAmount}
              onChange={e => setWalletAmount(e.target.value)}
              placeholder="Amount in $"
              style={{ maxWidth: 200 }}
            />
            <button className="btn btn-primary btn-sm" onClick={transferToWallet} disabled={walletBusy}>
              {walletBusy ? 'Transferring...' : 'Transfer'}
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            Main balance available: ${balance.toFixed(2)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            Bot Wallet balance: ${walletBalance.toFixed(2)}
          </div>
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input
                type="checkbox"
                className="toggle"
                checked={walletAutoSpend}
                disabled={walletAutoSpendBusy}
                onChange={e => toggleAutoSpend(e.target.checked)}
                style={{ flexShrink: 0, marginTop: 2 }}
              />
              <span>
                <div style={{ fontWeight: 500, fontSize: 13 }}>⚡ Auto-transfer from Main Balance</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>
                  When the Bot Wallet is empty, automatically spend from your Main Balance instead of pausing tasks.
                </div>
              </span>
            </label>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            Tip: entering an amount here and pressing Save Settings will also execute this transfer once.
          </div>
          <div style={{ fontSize: 12, color: 'var(--success)', marginTop: 4 }}>
            Approx token equivalent: {approxTokens == null ? 'Unavailable' : approxTokens.toLocaleString()} tokens
          </div>
          {walletMsg && (
            <div style={{ fontSize: 12, color: walletMsg.toLowerCase().includes('complete') ? 'var(--success)' : 'var(--warning)', marginTop: 8 }}>
              {walletMsg}
            </div>
          )}
          {balance <= 0 && (
            <div style={{ fontSize: 12, color: 'var(--warning)', marginTop: 8 }}>
              {walletBalance > 0
                ? `Main balance is $0.00. Bot Wallet has $${walletBalance.toFixed(2)}. Transfers only move Main Balance → Bot Wallet.`
                : 'Main balance is $0.00 and Bot Wallet is $0.00. Top up main credits first.'}
            </div>
          )}
        </div>

        {/* ── Cost Control (PRO) ───────────────────────────────────── */}
        <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
            💰 Cost Control
            {userPlan !== 'pro' && (
              <span style={{ fontSize: 10, fontWeight: 700, background: 'rgba(108,99,255,0.15)', color: 'var(--accent)', border: '1px solid rgba(108,99,255,0.3)', borderRadius: 4, padding: '1px 6px', marginLeft: 4 }}>⚡ PRO</span>
            )}
          </div>

          {userPlan !== 'pro' ? (
            <div style={{ padding: '14px 16px', background: 'color-mix(in srgb, var(--accent) 6%, var(--surface))', border: '1px dashed rgba(108,99,255,0.4)', borderRadius: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>⚡ PRO Feature</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>
                Budget gate, pre-run cost estimates, and push notifications are available on the <strong>PRO plan</strong>.
                These features give you full financial control over every run.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <a href="/pro-features" target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>
                  → See all PRO features
                </a>
                {!upgradePending && (
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>·</span>
                )}
                {!upgradePending ? (
                  <button
                    onClick={async () => {
                      await fetch('/api/upgrade-request', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '' }) });
                      setUpgradePending(true);
                    }}
                    style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600 }}
                  >
                    Request upgrade →
                  </button>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--success)' }}>✓ Upgrade request sent</span>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* Budget gate — gated by pf_budget_gate */}
              {planFeatures['pf_budget_gate'] !== false && (
                <>
                  <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', marginBottom: 12 }}>
                    <input type="checkbox" className="toggle" checked={budgetGateEnabled} onChange={e => setBudgetGateEnabled(e.target.checked)} style={{ flexShrink: 0, marginTop: 2 }} />
                    <span>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>🔒 Per-run budget gate</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>Pause and ask before spending more than your set credit limit per run. SUNy will show a checkpoint card when it approaches the cap.</div>
                    </span>
                  </label>
                  {budgetGateEnabled && (
                    <div style={{ marginBottom: 12, marginLeft: 28 }}>
                      <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Budget per run ($)</label>
                      <input type="number" min="0.001" step="0.01" className="input" value={budgetPerRun} onChange={e => setBudgetPerRun(e.target.value)} placeholder="e.g. 0.05" style={{ maxWidth: 140, fontSize: 13 }} />
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>SUNy stops and asks for confirmation when this amount is reached within a single run.</div>
                    </div>
                  )}
                </>
              )}

              {/* Forecast — gated by pf_cost_forecast */}
              {planFeatures['pf_cost_forecast'] !== false && (
                <>
                  <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', marginBottom: 12 }}>
                    <input type="checkbox" className="toggle" checked={forecastEnabled} onChange={e => setForecastEnabled(e.target.checked)} style={{ flexShrink: 0, marginTop: 2 }} />
                    <span>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>📋 Pre-run cost estimate</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>Before each run, SUNy estimates what it will cost based on your history or a brief AI analysis. <strong>Note:</strong> this estimate itself uses a small number of tokens (billed to you).</div>
                    </span>
                  </label>
                  {forecastEnabled && (
                    <div style={{ marginBottom: 12, marginLeft: 28 }}>
                      <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Billing mode for forecast tokens (leave blank to use current mode)</label>
                      <input type="text" className="input" value={forecastMarkupMode} onChange={e => setForecastMarkupMode(e.target.value)} placeholder="e.g. fast, pro" style={{ maxWidth: 220, fontSize: 13 }} />
                    </div>
                  )}
                </>
              )}

              {/* Push notifications — gated by pf_push_notifications */}
              {planFeatures['pf_push_notifications'] !== false && (
                <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: notifyPermission === 'unsupported' ? 'not-allowed' : 'pointer', marginBottom: 12, opacity: notifyPermission === 'unsupported' ? 0.5 : 1 }}>
                  <input
                    type="checkbox"
                    className="toggle"
                    checked={notifyOnComplete}
                    disabled={notifyPermission === 'unsupported'}
                    onChange={async (e) => {
                      if (e.target.checked && notifyPermission !== 'granted') {
                        const perm = await Notification.requestPermission();
                        setNotifyPermission(perm);
                        if (perm !== 'granted') return;
                      }
                      setNotifyOnComplete(e.target.checked);
                      try { localStorage.setItem('suny_notify_on_complete', String(e.target.checked)); } catch {}
                    }}
                    style={{ flexShrink: 0, marginTop: 2 }}
                  />
                  <span>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>🔔 Notify when run completes</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>
                      Get a browser notification with a receipt (files changed, credits used, test results) when SUNy finishes a run — even if the tab is in the background.
                      {notifyPermission === 'denied' && <span style={{ color: 'var(--error)', display: 'block', marginTop: 4 }}>⚠️ Notifications blocked by browser — allow them in browser settings first.</span>}
                      {notifyPermission === 'unsupported' && <span style={{ display: 'block', marginTop: 4 }}>Not supported in this browser.</span>}
                    </div>
                  </span>
                </label>
              )}
            </>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 8, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={onBack}>
            ← Back
          </button>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginLeft: 'auto' }}>
          <button className="btn btn-primary" onClick={saveSettings} style={{ justifyContent: 'center' }}>
            {saved ? '✓ Saved!' : '💾 Save Settings'}
          </button>
          <button className="btn btn-secondary" onClick={handleLogout}>
            <LogOut size={14} /> Sign Out
          </button>
          </div>
        </div>
      </div>
    </div>
  );
}
