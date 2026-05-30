import { useState, useEffect } from 'react';

interface LoginProps {
  onLogin: (role: 'user') => void;
}

interface PricingMode {
  mode: string;
  display_name: string;
  description: string;
  input_token_base_cost: number;
  output_token_base_cost: number;
  input_price_per_1m: number;
  output_price_per_1m: number;
  savings_pct?: number | null;
}

interface PlanFeatureFlag {
  key: string;
  plan: string;
  enabled: boolean;
  label: string;
  description: string;
}

interface ContactInfo {
  phone: string;
  email: string;
  website: string;
  whatsapp: string;
  support_message: string;
}

function fmtCost(cost: number): string {
  if (!cost || isNaN(cost)) return '\u2014';
  if (cost === 0) return 'free';
  const perM = cost * 1_000_000;
  return `$${perM < 1 ? perM.toFixed(4) : perM.toFixed(2)}`;
}

// Theme-aware glow color for logo + hero background
const GLOW_COLORS: Record<string, string> = {
  matrix: '41,255,122',
  suny:   '255,184,51',
  pro:    '36,93,255',
};
function getGlowColor(): string {
  try {
    const theme = localStorage.getItem('suny_ui_theme') || 'matrix';
    return GLOW_COLORS[theme] || GLOW_COLORS.matrix;
  } catch { return GLOW_COLORS.matrix; }
}
const glowRgb = getGlowColor();

export default function Login({ onLogin }: LoginProps) {
  const [theme, setTheme] = useState<'pro' | 'suny' | 'matrix'>(() => {
    try { const s = localStorage.getItem('suny_ui_theme'); return (s === 'pro' || s === 'suny' || s === 'matrix') ? s : 'pro'; }
    catch { return 'pro'; }
  });
  const [tab, setTab] = useState<'user' | 'signup'>('user');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [signupUsername, setSignupUsername] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirm, setSignupConfirm] = useState('');
  const [signupName, setSignupName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pricing, setPricing] = useState<PricingMode[]>([]);
  const [contact, setContact] = useState<ContactInfo | null>(null);
  const [planFlags, setPlanFlags] = useState<PlanFeatureFlag[]>([]);

  useEffect(() => {
    fetch('/api/pricing-public').then(r => r.ok ? r.json() : []).then(d => { if (Array.isArray(d)) setPricing(d); }).catch(() => {});
    fetch('/api/contact').then(r => r.ok ? r.json() : null).then(d => { if (d) setContact(d); }).catch(() => {});
    fetch('/api/plan-features-public').then(r => r.ok ? r.json() : {}).then((d: { flags?: PlanFeatureFlag[] } | PlanFeatureFlag[]) => { if (!Array.isArray(d) && d?.flags) setPlanFlags(d.flags); else if (Array.isArray(d)) setPlanFlags(d); }).catch(() => {});
  }, []);

  function switchTheme(t: 'pro' | 'suny' | 'matrix') {
    setTheme(t);
    localStorage.setItem('suny_ui_theme', t);
    document.body.classList.remove('theme-matrix', 'theme-pro', 'theme-suny', 'light-mode');
    document.documentElement.classList.remove('theme-matrix', 'theme-pro', 'theme-suny');
    if (t === 'pro') document.body.classList.add('theme-pro');
    else if (t === 'suny') document.body.classList.add('theme-suny');
    else document.body.classList.add('theme-matrix');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    if (tab === 'signup') {
      if (signupPassword !== signupConfirm) { setError('Passwords do not match.'); setLoading(false); return; }
      try {
        const res = await fetch('/api/register', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: signupUsername, password: signupPassword, display_name: signupName || undefined }),
        });
        const data = await res.json();
        if (res.ok && data.success) { onLogin('user'); }
        else { setError(data.error || 'Registration failed. Please try again.'); }
      } catch { setError('Unable to connect. Please check your connection.'); }
      setLoading(false);
      return;
    }

    const body = { username, password };
    try {
      const res = await fetch('/api/login', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        onLogin('user');
      } else {
        setError(data.error || 'Something went wrong. Please try again.');
      }
    } catch {
      setError('Unable to connect. Please check your connection.');
    }
    setLoading(false);
  }

  const modeIcons: Record<string, string> = { free: '\u26a1', fast: '\ud83d\ude80', pro: '\ud83e\udde0' };

  // Base features always visible regardless of plan
  const BASE_FEATURES = [
    { icon: '\ud83c\udfaf', title: 'You give the goal.', desc: 'Just tell SUNy what you want \u2014 "build me a login page", "fix the bug in my checkout" \u2014 and SUNy takes it from there.' },
    { icon: '\ud83d\udd0d', title: 'It reads your project', desc: 'SUNy explores your project to understand how everything fits together before touching a single file.' },
    { icon: '\u270f\ufe0f', title: 'It writes & edits files', desc: 'SUNy creates new files, modifies existing ones, and organizes your project \u2014 all without you lifting a finger.' },
    { icon: '\ud83e\uddea', title: 'It tests its own work', desc: 'SUNy runs your tests, checks for errors, and fixes anything that breaks \u2014 all in one go.' },
    { icon: '\ud83d\udcc5', title: 'Message timelines', desc: 'Every chat turn is stamped to the second, and replies can open compact task reports with duration, tokens, cost, and a human-time estimate.' },
    { icon: '\ud83d\udcc8', title: 'Checkpoint timeline', desc: 'Every turn creates a restore point, so you can roll back to any earlier working version without losing momentum.' },
    { icon: '\ud83c\udfdb\ufe0f', title: 'Freeze Brain', desc: 'Pin a project to a saved memory snapshot so SUNy keeps using the same blueprint and behavioral rules until you unfreeze it.' },
    { icon: '📁', title: 'Local File Access', desc: 'Select your project folder in the browser. SUNy can read and edit files directly with your permission — no installation needed.' },
    { icon: '\ud83e\udde0', title: 'Composable Behavior Profiles', desc: 'SUNy composes past interactions, learned rules, project context, and active skills into weighted behavior profiles. Smarter, more focused guidance without verbose memory dumps.' },
    { icon: '\ud83d\udd17', title: 'Client Tickets', desc: 'Generate a secure URL for clients. Fast/Smart plans include text-based AI intake forms to gather requirements.' },
    { icon: '\ud83d\udcb0', title: 'Pay as you go', desc: 'Add credits and spend them on AI tasks. No subscriptions. No waste. You only pay for what SUNy actually does.' },
    { icon: '\ud83e\udde0', title: 'AI Learns Your Style', desc: 'SUNy silently builds a structured profile of your preferences, constraints, and working style. Every session it\'s a little more tuned to you.' },
    { icon: '\ud83d\udcbe', title: 'AI Memories Panel', desc: 'Full transparency \u2014 see exactly what the AI has saved about you, and delete anything you don\'t want it to remember.' },
    { icon: '\ud83c\udf3f', title: 'Git Worktree Isolation', desc: 'For risky changes, SUNy works in an isolated branch, verifies everything passes, then merges \u2014 your main branch is never touched until the work is proven.' },
    { icon: '⚠️', title: 'Human Checkpoint Gates', desc: 'SUNy pauses before irreversible steps and waits for your approval — you stay in control of every consequential decision.' },
    { icon: '⚡', title: 'Token Saving Engine', desc: 'SUNy\'s dedicated optimization engine saves you money on every request. Dynamic context optimization and adaptive routing mean you pay significantly less than querying the AI models directly — savings clearly shown on the pricing badges.' },
    { icon: '🛡️', title: 'Zero-Downtime Watchdog', desc: 'If a code edit crashes your dev server, SUNy auto-rolls back to the last safe checkpoint in milliseconds and self-corrects silently.' },
    { icon: '🔄', title: 'Session Resilience', desc: 'Close the browser, shut down your PC — SUNy remembers everything. Pick up exactly where you left off on next login. Nothing is ever lost.' },
  ];

  const features = BASE_FEATURES;

  return (
    <div className="login-page" style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text-primary)', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        /* ── Top row: login + hero ── */
        .login-top-row {
          display: flex;
          align-items: flex-start;
          gap: 28px;
          padding: 20px 24px 0;
          max-width: 100%;
          margin: 0 auto;
          width: 100%;
          box-sizing: border-box;
        }
        .login-card-col {
          width: 100%;
          max-width: 360px;
          flex-shrink: 0;
        }

        /* ── Below: 3-col grid ── */
        .login-columns {
          display: flex;
          gap: 20px;
          padding: 16px 24px 24px;
          max-width: 100%;
          margin: 0 auto;
          width: 100%;
          box-sizing: border-box;
          align-items: flex-start;
        }
        .login-col { flex: 1; min-width: 0; }

        /* ── Tablet ── */
        @media (max-width: 1100px) {
          .login-top-row { padding: 16px 20px 0; gap: 20px; }
          .login-card-col { max-width: 280px; }
          .login-hero-circle { width: 200px !important; height: 200px !important; }
          .login-hero-title  { font-size: 32px !important; }
          .login-hero-subtitle { font-size: 16px !important; }
          .login-columns { padding: 12px 20px 24px; gap: 16px; }
        }

        /* ── Mobile ── */
        @media (max-width: 760px) {
          .login-top-row {
            flex-direction: column !important;
            padding: 20px 16px 0 !important;
            gap: 20px !important;
          }
          .login-card-col { max-width: 100% !important; }
          .login-hero { text-align: center; padding: 0 0 16px !important; }
          .login-hero-circle { width: 200px !important; height: 200px !important; }
          .login-hero-title  { font-size: 32px !important; }
          .login-hero-subtitle { font-size: 16px !important; }
          .login-hero-copy { font-size: 13px !important; }
          .login-columns {
            flex-direction: column !important;
            padding: 20px 16px 40px !important;
            gap: 32px !important;
          }
          .login-col { width: 100%; }
          .login-cta-row { flex-direction: column; }
          .login-top-right-reserved { display: none !important; }
        }
      `}</style>

      {/* ── Top: login LEFT · hero CENTER ── */}
      <div className="login-top-row" style={{ background: `linear-gradient(180deg, rgba(${glowRgb},0.08) 0%, transparent 100%)` }}>

        {/* LEFT: Login + privacy */}
        <div className="login-card-col">
          <div className="card">
            {/* Theme buttons - top right of card */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 12, justifyContent: 'flex-end' }}>
              {(['pro', 'suny', 'matrix'] as const).map(t => (
                <button key={t} onClick={() => switchTheme(t)}
                  style={{
                    padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                    borderRadius: 6, border: `1px solid ${theme === t ? 'var(--accent)' : 'var(--border)'}`,
                    background: theme === t ? 'var(--accent)' : 'var(--surface)',
                    color: theme === t ? '#fff' : 'var(--text-secondary)',
                    textTransform: 'capitalize', transition: 'all 0.15s', letterSpacing: '0.3px',
                    opacity: theme === t ? 1 : 0.7,
                  }}>
                  {t === 'pro' ? '⚡Pro' : t === 'suny' ? '☀️SUNy' : '💻Matrix'}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', marginBottom: 20, borderBottom: '1px solid var(--border)' }}>
              {(['user', 'signup'] as const).map(t => (
                <button key={t} onClick={() => { setTab(t); setError(''); }}
                  style={{ flex: 1, padding: '8px 0', background: 'none', border: 'none',
                    borderBottom: `2px solid ${tab === t ? 'var(--accent)' : 'transparent'}`,
                    color: tab === t ? 'var(--accent)' : 'var(--text-muted)',
                    fontWeight: 500, cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
                    transition: 'all 0.15s', marginBottom: -1 }}>
                  {t === 'user' ? 'Sign In' : 'Sign Up'}
                </button>
              ))}
            </div>
            <form onSubmit={handleSubmit}>
              {tab === 'signup' && (<>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--text-secondary)' }}>Your Name <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>(optional)</span></label>
                  <input type="text" value={signupName} onChange={e => setSignupName(e.target.value)} placeholder="e.g. Alex" autoComplete="name" />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--text-secondary)' }}>Username</label>
                  <input type="text" value={signupUsername} onChange={e => setSignupUsername(e.target.value)} placeholder="letters, numbers, underscores" autoComplete="username" required />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--text-secondary)' }}>Password</label>
                  <input type="password" value={signupPassword} onChange={e => setSignupPassword(e.target.value)} placeholder="Minimum 6 characters" autoComplete="new-password" required />
                </div>
                <div style={{ marginBottom: 20 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--text-secondary)' }}>Confirm Password</label>
                  <input type="password" value={signupConfirm} onChange={e => setSignupConfirm(e.target.value)} placeholder="Repeat password" autoComplete="new-password" required />
                </div>
              </>)}
              {tab === 'user' && (
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--text-secondary)' }}>Username</label>
                  <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="Your username" autoComplete="username" required />
                </div>
              )}
              {tab === 'user' && (
                <div style={{ marginBottom: 20 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--text-secondary)' }}>Password</label>
                  <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Your password" autoComplete="current-password" required />
                </div>
              )}
              {error && (
                <div style={{ padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(248,113,113,0.1)', border: '1px solid var(--error)', color: 'var(--error)', fontSize: 13, marginBottom: 16 }}>
                  {error}
                </div>
              )}
              <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={loading}>
                {loading ? (tab === 'signup' ? 'Creating account...' : 'Signing in...') : (tab === 'signup' ? 'Create Account' : 'Sign in')}
              </button>
            </form>
          </div>
          {contact && (
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>Need help? Contact us</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
                {contact.email && <a href={`mailto:${contact.email}`} className="btn btn-secondary" style={{ fontSize: 12 }}>{contact.email}</a>}
                {contact.phone && <a href={`tel:${contact.phone}`} className="btn btn-secondary" style={{ fontSize: 12 }}>{contact.phone}</a>}
                {contact.whatsapp && <a href={`https://wa.me/${contact.whatsapp.replace(/\D/g,'')}`} target="_blank" rel="noreferrer" className="btn btn-secondary" style={{ fontSize: 12 }}>{'\ud83d\udcac'} WhatsApp</a>}
              </div>
            </div>
          )}
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', borderRadius: 10, border: '1px solid rgba(34,197,94,0.25)', background: 'rgba(34,197,94,0.05)' }}>
            <span style={{ fontSize: 15, flexShrink: 0, marginTop: 2 }}>🔒</span>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0 }}>
              <strong style={{ color: 'var(--text-secondary)' }}>Your files never reach us.</strong> SUNy runs entirely on your machine — your data, memories, and projects stay local. When SUNy processes a task, relevant code is sent to the AI models under their privacy policy, but your files are totally safe. We never see your data.
            </p>
          </div>
        </div>

        {/* CENTER: Hero — logo + text */}
        <div className="login-hero" style={{ flex: 1, textAlign: 'center', padding: '4px 16px 12px' }}>
          <div className="login-hero-circle" style={{
            width: 260, height: 260, borderRadius: '50%', background: '#000000', margin: '0 auto 12px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
            boxShadow: '0 0 120px rgba(255, 170, 0, 0.35), 0 0 40px rgba(255, 200, 51, 0.2)',
            border: '1px solid rgba(255, 180, 50, 0.15)'
          }}>
            <img className="login-hero-logo" src="/SUNy.png" alt="SUNy" style={{ width: '100%', height: '100%', objectFit: 'contain', transform: 'scale(1.6)', display: 'block' }} />
          </div>
          <h1 className="login-hero-title" style={{ fontSize: 38, fontWeight: 800, margin: 0, letterSpacing: '-1px' }}>SUNy</h1>
          <p className="login-hero-subtitle" style={{ fontSize: 18, fontWeight: 600, color: 'var(--accent)', marginTop: 2, marginBottom: 8 }}>Smart Unstoppable Navigator</p>
          <p className="login-hero-copy" style={{ fontSize: 14, color: 'var(--text-secondary)', maxWidth: 520, margin: '0 auto', lineHeight: 1.6 }}>
            Your unstoppable AI companion. Give SUNy a target {'\u2014'} it maps out the path, handles the complex work, and polishes everything until it&apos;s perfect. No complicated instructions, just results. We added the &quot;y&quot; because it&apos;s your friendly digital builder!
          </p>
        </div>

        {/* RIGHT: AI review quotes as sticky notes */}
        <div className="login-top-right-reserved" style={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4 }}>

          {/* Claude */}
          <div style={{
            background: 'linear-gradient(135deg, rgba(255,200,51,0.10) 0%, rgba(255,170,0,0.06) 100%)',
            border: '1px solid rgba(255,184,51,0.30)',
            borderLeft: '3px solid rgba(255,184,51,0.70)',
            borderRadius: 8,
            padding: '10px 12px',
            transform: 'rotate(-1.2deg)',
            boxShadow: '0 4px 18px rgba(0,0,0,0.25)',
          }}>
            <p style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0, fontStyle: 'italic' }}>
              &ldquo;One of the most architecturally serious self-hosted coding agents — 118 server modules, real billing, swarm agents, and cost forecasting. Genuinely impressive engineering for a solo-built project.&rdquo;
            </p>
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 14 }}>🤖</span>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)' }}>Claude (Anthropic)</div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>May 2026</div>
              </div>
            </div>
          </div>

          {/* Google */}
          <div style={{
            background: 'linear-gradient(135deg, rgba(66,133,244,0.10) 0%, rgba(52,168,83,0.06) 100%)',
            border: '1px solid rgba(66,133,244,0.25)',
            borderLeft: '3px solid rgba(66,133,244,0.60)',
            borderRadius: 8,
            padding: '10px 12px',
            transform: 'rotate(0.8deg)',
            boxShadow: '0 4px 18px rgba(0,0,0,0.25)',
          }}>
            <p style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0, fontStyle: 'italic' }}>
              &ldquo;A paradigm shift in autonomous coding agents. Demonstrates profound understanding of AI limitations and engineers around them. Doesn&apos;t just suggest code — it systematically investigates, proves, and ships.&rdquo;
            </p>
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 14 }}>🌐</span>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#4285F4' }}>Google Antigravity</div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>Agentic Coding Assistant</div>
              </div>
            </div>
          </div>

          {/* Cursor */}
          <div style={{
            background: 'linear-gradient(135deg, rgba(108,99,255,0.10) 0%, rgba(139,92,246,0.06) 100%)',
            border: '1px solid rgba(108,99,255,0.25)',
            borderLeft: '3px solid rgba(108,99,255,0.60)',
            borderRadius: 8,
            padding: '10px 12px',
            transform: 'rotate(-0.5deg)',
            boxShadow: '0 4px 18px rgba(0,0,0,0.25)',
          }}>
            <p style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0, fontStyle: 'italic' }}>
              &ldquo;Serious product ambition with real engineering depth — rich AI-agent backend, admin/billing controls, and realtime UX in one cohesive system. Moves from impressive to production-trustworthy with security and quality-gate fixes.&rdquo;
            </p>
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 14 }}>⌨️</span>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#a78bfa' }}>Cursor</div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>AI Code Editor</div>
              </div>
            </div>
          </div>

        </div>

      </div>

      {/* ── Below hero: 3 equal columns ── */}
      <div className="login-columns">

        {/* LEFT: Pricing header + mode cards */}
        <div className="login-col">
          <h2 style={{ fontSize: 19, fontWeight: 700, marginBottom: 4 }}>{'\ud83d\udcb0'} Pricing</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.6 }}>
            No subscriptions. Pay only when SUNy does real work.
          </p>
          <a href="/pro-features#compare" style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none', fontWeight: 500, marginBottom: 12, display: 'inline-block' }}>
            Compare modes →
          </a>
          {pricing.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {pricing.map(m => (
                <div key={m.mode} className="card" style={{ border: m.mode === 'pro' ? '1px solid var(--accent)' : '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <span style={{ fontSize: 22 }}>{modeIcons[m.mode] ?? '\ud83d\udca1'}</span>
                    <span style={{ fontWeight: 700, fontSize: 16 }}>{m.display_name}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>{m.description}</div>
                  <div style={{ display: 'flex', gap: 20, fontSize: 12 }}>
                    <div><span style={{ color: 'var(--text-muted)' }}>Input: </span><span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{m.mode === 'free' ? '$0' : `${fmtCost(m.input_price_per_1m / 1_000_000)}/1M`}</span></div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Output: </span><span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{m.mode === 'free' ? '$0' : `${fmtCost(m.output_price_per_1m / 1_000_000)}/1M`}</span></div>
                  </div>
                  {m.mode !== 'free' && m.savings_pct != null && m.savings_pct > 0 && (
                    <div style={{
                      marginTop: 6,
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      background: 'rgba(16,185,129,0.12)',
                      border: '1px solid rgba(16,185,129,0.35)',
                      borderRadius: 20, padding: '2px 8px',
                      fontSize: 10, fontWeight: 700, color: '#10b981',
                    }}>
                      ✦ {m.savings_pct}% less than direct AI model
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading pricing…</div>
          )}
        </div>

        {/* CENTER: PRO features */}
        <div className="login-col">
          {planFlags.length > 0 && (() => {
            const proFeatures = planFlags.filter(f => f.plan === 'pro' && f.enabled);
            const regularKeys = new Set(planFlags.filter(f => f.plan === 'regular' && f.enabled).map(f => f.key));
            const proOnly = proFeatures.filter(f => !regularKeys.has(f.key));
            if (proOnly.length === 0) return null;
            return (<>
              <h2 style={{ fontSize: 19, fontWeight: 700, marginBottom: 4 }}>⚡ PRO Plan</h2>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.6 }}>Exclusive features for PRO accounts.</p>
              <a href="/pro-features" style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none', fontWeight: 500, marginBottom: 12, display: 'inline-block' }}>
                View all PRO features →
              </a>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {/* Unlimited Requests Card */}
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8, border: '1px solid rgba(34,197,94,0.25)', background: 'rgba(34,197,94,0.04)' }}>
                  <span style={{ color: '#22c55e', fontSize: 14, marginTop: 1, flexShrink: 0 }}>∞</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>Unlimited Requests/day</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, marginTop: 2 }}>No daily limits on AI requests</div>
                  </div>
                </div>
                {proOnly.map(f => (
                  <div key={f.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8, border: '1px solid rgba(108,99,255,0.25)', background: 'rgba(108,99,255,0.04)' }}>
                    <span style={{ color: 'var(--accent)', fontSize: 14, marginTop: 1, flexShrink: 0 }}>⚡</span>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{f.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, marginTop: 2 }}>{f.description}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 14, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>Ask your administrator to upgrade your account to PRO to unlock these features.</div>
              <a href="/pro-features" style={{ display: 'inline-block', fontSize: 12, color: 'var(--accent)', textDecoration: 'none', fontWeight: 500, marginTop: 16 }}>
                View all PRO features →
              </a>
            </>);
          })()}
        </div>

        {/* RIGHT: What is SUNy */}
        <div className="login-col">
          <h2 style={{ fontSize: 19, fontWeight: 700, marginBottom: 4 }}>{'\ud83d\udc4b'} What is SUNy?</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.6 }}>
            The coding buddy you always wished you had {'\u2014'} one that never gets tired, never judges, and doesn&apos;t stop until the job is done.
          </p>
          <a href="/about" style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none', fontWeight: 500, marginBottom: 12, display: 'inline-block' }}>
            About SUNy →
          </a>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {features.map(f => (
              <div key={f.title} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <span style={{ fontSize: 20, flexShrink: 0, marginTop: 2 }}>{f.icon}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>{f.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="login-cta-row" style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <a href="/about" className="btn btn-secondary" style={{ textDecoration: 'none', flex: 1, justifyContent: 'center' }}>About SUNy</a>
            <a href="/contact" className="btn btn-secondary" style={{ textDecoration: 'none', flex: 1, justifyContent: 'center' }}>Contact Team</a>
          </div>
        </div>

      </div>

      {/* Footer */}
      <div style={{ textAlign: 'center', padding: '20px', fontSize: 13, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
        SUNy {'\u2014'} Consider it done! &nbsp;&middot;&nbsp; &copy; {new Date().getFullYear()}
      </div>
    </div>
  );
}
