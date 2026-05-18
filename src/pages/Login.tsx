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
}

interface ContactInfo {
  phone: string;
  email: string;
  website: string;
  whatsapp: string;
  support_message: string;
}

function fmtCost(cost: number): string {
  if (!cost || isNaN(cost)) return '—';
  if (cost === 0) return 'free';
  const perM = cost * 1_000_000;
  return `$${perM < 1 ? perM.toFixed(4) : perM.toFixed(2)}`;
}

export default function Login({ onLogin }: LoginProps) {
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

  useEffect(() => {
    fetch('/api/pricing-public').then(r => r.ok ? r.json() : []).then(d => { if (Array.isArray(d)) setPricing(d); }).catch(() => {});
    fetch('/api/contact').then(r => r.ok ? r.json() : null).then(d => { if (d) setContact(d); }).catch(() => {});
  }, []);

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

    const endpoint = '/api/login';
    const body = { username, password };
    try {
      const res = await fetch(endpoint, {
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

  const modeIcons: Record<string, string> = { free: '⚡', fast: '🚀', pro: '🧠' };

  const features = [
    { icon: '🎯', title: 'You give the goal.', desc: 'Just tell GABy what you want — "build me a login page", "fix the bug in my checkout" — and GABy takes it from there.' },
    { icon: '🔍', title: 'It reads your project', desc: 'GABy explores your project to understand how everything fits together before touching a single file.' },
    { icon: '✏️', title: 'It writes & edits files', desc: 'GABy creates new files, modifies existing ones, and organizes your project — all without you lifting a finger.' },
    { icon: '🧪', title: 'It tests its own work', desc: 'GABy runs your tests, checks for errors, and fixes anything that breaks — all in one go.' },
    { icon: '🔗', title: 'Local Bridge', desc: 'A tiny background agent on your machine lets GABy edit real local files — nothing is uploaded to any cloud.' },
    { icon: '💰', title: 'Pay as you go', desc: 'Add credits and spend them on AI tasks. No subscriptions. No waste. You only pay for what GABy actually does.' },
  ];

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text-primary)', display: 'flex', flexDirection: 'column' }}>

      {/* Hero */}
      <div style={{ textAlign: 'center', padding: '48px 20px 36px', background: 'linear-gradient(180deg, rgba(108,99,255,0.08) 0%, transparent 100%)' }}>
        <img src="/GABy.png" alt="GABy" style={{ width: 280, height: 280, borderRadius: '50%', objectFit: 'cover', margin: '0 auto 24px', display: 'block', boxShadow: '0 8px 40px rgba(108,99,255,0.35)' }} />
        <h1 style={{ fontSize: 52, fontWeight: 800, marginBottom: 10, letterSpacing: '-1px' }}>GABy</h1>
        <p style={{ fontSize: 24, fontWeight: 600, color: 'var(--accent)', marginBottom: 14 }}>Consider it done!</p>
        <p style={{ fontSize: 16, color: 'var(--text-secondary)', maxWidth: 620, margin: '0 auto', lineHeight: 1.75 }}>
          Your unstoppable AI companion. Give GABy a target — it maps out the path, handles the complex work, and polishes everything until it&apos;s perfect. No complicated instructions, just results.
        </p>
      </div>

      {/* 3-column: Pricing | Sign In | What is GABy */}
      <div style={{ flex: 1, display: 'flex', gap: 28, padding: '40px 48px 64px', maxWidth: 1400, margin: '0 auto', width: '100%', boxSizing: 'border-box', alignItems: 'flex-start' }}>

        {/* LEFT: Pricing */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ fontSize: 19, fontWeight: 700, marginBottom: 6 }}>💰 Pricing</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20, lineHeight: 1.6 }}>
            No subscriptions. Pay only when GABy does real work.
          </p>
          <div style={{ marginBottom: 14 }}>
            <a href="/plans" style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}>
              View detailed plans & features →
            </a>
          </div>
          {pricing.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {pricing.map(m => (
                <div key={m.mode} className="card" style={{ border: m.mode === 'pro' ? '1px solid var(--accent)' : '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <span style={{ fontSize: 22 }}>{modeIcons[m.mode] ?? '💡'}</span>
                    <span style={{ fontWeight: 700, fontSize: 16 }}>{m.display_name}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>{m.description}</div>
                  <div style={{ display: 'flex', gap: 20, fontSize: 12 }}>
                    <div><span style={{ color: 'var(--text-muted)' }}>Input: </span><span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{fmtCost(m.input_token_base_cost)}/1M</span></div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Output: </span><span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{fmtCost(m.output_token_base_cost)}/1M</span></div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading pricing…</div>
          )}
        </div>

        {/* CENTER: Sign In */}
        <div style={{ width: 360, flexShrink: 0 }}>
          <div className="card">
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
                  <input type="text" value={signupName} onChange={e => setSignupName(e.target.value)}
                    placeholder="e.g. Alex" autoComplete="name" />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--text-secondary)' }}>Username</label>
                  <input type="text" value={signupUsername} onChange={e => setSignupUsername(e.target.value)}
                    placeholder="letters, numbers, underscores" autoComplete="username" required />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--text-secondary)' }}>Password</label>
                  <input type="password" value={signupPassword} onChange={e => setSignupPassword(e.target.value)}
                    placeholder="Minimum 6 characters" autoComplete="new-password" required />
                </div>
                <div style={{ marginBottom: 20 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--text-secondary)' }}>Confirm Password</label>
                  <input type="password" value={signupConfirm} onChange={e => setSignupConfirm(e.target.value)}
                    placeholder="Repeat password" autoComplete="new-password" required />
                </div>
              </>)}
              {tab === 'user' && (
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--text-secondary)' }}>Username</label>
                  <input type="text" value={username} onChange={e => setUsername(e.target.value)}
                    placeholder="Your username" autoComplete="username" required />
                </div>
              )}
              {tab === 'user' && (
                <div style={{ marginBottom: 20 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--text-secondary)' }}>Password</label>
                  <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                    placeholder="Your password" autoComplete="current-password" required />
                </div>
              )}
              {error && (
                <div style={{ padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(248,113,113,0.1)',
                  border: '1px solid var(--error)', color: 'var(--error)', fontSize: 13, marginBottom: 16 }}>
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
                {contact.whatsapp && <a href={`https://wa.me/${contact.whatsapp.replace(/\D/g,'')}`} target="_blank" rel="noreferrer" className="btn btn-secondary" style={{ fontSize: 12 }}>💬 WhatsApp</a>}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT: What is GABy */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ fontSize: 19, fontWeight: 700, marginBottom: 6 }}>👋 What is GABy?</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20, lineHeight: 1.6 }}>
            The coding buddy you always wished you had — one that never gets tired, never judges, and doesn&apos;t stop until the job is done.
          </p>
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
        </div>

      </div>

      {/* Footer */}
      <div style={{ textAlign: 'center', padding: '20px', fontSize: 13, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
        GABy — Consider it done! &nbsp;&middot;&nbsp; &copy; {new Date().getFullYear()}
      </div>
    </div>
  );
}