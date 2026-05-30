import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface PlanFeatureFlag {
  key: string;
  plan: string;
  enabled: boolean;
  label: string;
  description: string;
}

interface PricingMode {
  mode: string;
  display_name: string;
  description: string;
  input_price_per_1m: number;
  output_price_per_1m: number;
}

interface UserInfo {
  plan?: string;
  upgrade_pending?: boolean;
}

// Mode capability profiles — no model names exposed to UI
const MODE_DETAILS: Record<string, {
  icon: string;
  name: string;
  tier: string;
  reasoning: string;
  speed: string;
  best_for: string;
  color: string;
}> = {
  free: {
    icon: '⚡',
    name: 'Free',
    tier: 'Entry-tier — no credit cost',
    reasoning: 'Basic — single-pass, no chain-of-thought. Handles simple Q&A and short edits only.',
    speed: 'Fastest',
    best_for: 'Quick questions, short snippets, casual chat',
    color: '#6b7280',
  },
  fast: {
    icon: '🚀',
    name: 'Fast',
    tier: 'Balanced speed & capability',
    reasoning: 'Good — strong code understanding, fast tool use, handles most real-world coding tasks reliably.',
    speed: 'Fast',
    best_for: 'Everyday coding, bug fixes, file edits, API work',
    color: '#3b82f6',
  },
  smart: {
    icon: '🧠',
    name: 'Smart',
    tier: 'Deep reasoning & analysis',
    reasoning: 'Deep — multi-step reasoning, architecture decisions, complex refactors, nuanced analysis.',
    speed: 'Medium',
    best_for: 'Complex features, architecture, review & analysis',
    color: '#8b5cf6',
  },
  pro: {
    icon: '💎',
    name: 'Pro',
    tier: 'Frontier — highest capability',
    reasoning: 'Expert — frontier reasoning, multi-model task routing, deep context, hypothesis engine. Best possible output.',
    speed: 'Slower (worth it)',
    best_for: 'Critical tasks, large codebases, research, highest quality',
    color: '#f59e0b',
  },
};

export default function ProFeatures() {
  const navigate = useNavigate();
  const [features, setFeatures] = useState<PlanFeatureFlag[]>([]);
  const [pricing, setPricing] = useState<PricingMode[]>([]);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [regularDailyLimit, setRegularDailyLimit] = useState<number | null>(null);
  const [upgradeState, setUpgradeState] = useState<'idle' | 'loading' | 'sent'>('idle');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/plan-features-public', { credentials: 'include' }).then(r => r.ok ? r.json() : {}),
      fetch('/api/pricing-public', { credentials: 'include' }).then(r => r.ok ? r.json() : []),
      fetch('/api/me', { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([planData, pricingData, me]) => {
      const pd = planData as { flags?: PlanFeatureFlag[]; regular_daily_limit?: number | null } | PlanFeatureFlag[];
      const flags = Array.isArray(pd) ? pd : (pd?.flags ?? []);
      setFeatures(flags);
      setRegularDailyLimit(Array.isArray(pd) ? null : (pd?.regular_daily_limit ?? null));
      setPricing(Array.isArray(pricingData) ? pricingData : []);
      setUserInfo(me);
      if (me?.upgrade_pending) setUpgradeState('sent');
      setLoading(false);
    });
  }, []);

  // PRO-only features (enabled for pro but not for regular)
  const regularEnabledKeys = new Set(features.filter(f => f.plan === 'regular' && f.enabled).map(f => f.key));
  const proOnlyFeatures = features
    .filter(f => f.plan === 'pro' && f.enabled && !regularEnabledKeys.has(f.key));

  const isPro = userInfo?.plan === 'pro';

  // Modes to show in the comparison table (order matters)
  const MODE_ORDER = ['free', 'fast', 'smart', 'pro'];
  const pricingMap = Object.fromEntries(pricing.map(p => [p.mode, p]));

  function fmtPrice(val: number | undefined) {
    if (!val) return 'Free';
    const perM = val;
    return `$${perM < 1 ? perM.toFixed(4) : perM.toFixed(2)}/1M`;
  }

  async function requestUpgrade() {
    if (upgradeState !== 'idle') return;
    setUpgradeState('loading');
    try {
      await fetch('/api/upgrade-request', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'From Plans & Pricing page' }) });
      setUpgradeState('sent');
    } catch {
      setUpgradeState('idle');
    }
  }

  const TH: React.CSSProperties = { padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.05em', color: 'var(--text-muted)', background: 'var(--surface)', borderBottom: '1px solid var(--border)' };
  const TD: React.CSSProperties = { padding: '10px 14px', fontSize: 13, borderBottom: '1px solid var(--border)', verticalAlign: 'top' };
  const TDlast: React.CSSProperties = { ...TD, borderBottom: 'none' };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text-primary)', fontFamily: 'var(--font-sans, system-ui)' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '32px 20px 72px' }}>

        <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, marginBottom: 24, display: 'flex', alignItems: 'center', gap: 6, padding: 0 }}>
          ← Back
        </button>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 6 }}>
          <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Plans &amp; Pricing</h1>
          {isPro && <span style={{ fontSize: 11, fontWeight: 700, background: 'rgba(108,99,255,0.2)', color: 'var(--accent)', border: '1px solid rgba(108,99,255,0.4)', borderRadius: 6, padding: '3px 10px' }}>⚡ PRO PLAN ✓</span>}
        </div>
        <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 36, lineHeight: 1.6 }}>
          All users access the same 4 reasoning modes. The difference between Regular and PRO is about message limits and exclusive features — not which modes you can use.
        </p>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
            <div className="thinking-indicator"><div className="dot" /><div className="dot" /><div className="dot" /></div>
          </div>
        ) : (<>

          {/* ── Section 1: Reasoning Mode Cards (1 row) ── */}
          <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>🧠 Reasoning Modes</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.6 }}>
            All modes are available to every user. Pick per task or use <strong>Auto</strong>. Difference is reasoning depth, speed, and cost.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
            {MODE_ORDER.map(modeKey => {
              const d = MODE_DETAILS[modeKey];
              if (!d) return null;
              const p = pricingMap[modeKey];
              return (
                <div key={modeKey} style={{ padding: '16px 14px', border: `1px solid ${d.color}44`, borderTop: `3px solid ${d.color}`, borderRadius: 10, background: 'var(--surface)' }}>
                  <div style={{ fontSize: 22, marginBottom: 6 }}>{d.icon}</div>
                  <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{d.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.5 }}>{d.tier}</div>
                  {p && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 8 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>In: <strong>{fmtPrice(p.input_price_per_1m)}</strong></span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Out: <strong>{fmtPrice(p.output_price_per_1m)}</strong></span>
                    </div>
                  )}
                  <div style={{ fontSize: 11, fontWeight: 600, color: d.color }}>⚡ {d.speed}</div>
                </div>
              );
            })}
          </div>

          {/* Mode comparison table */}
          <div style={{ overflowX: 'auto', marginBottom: 48, borderRadius: 10, border: '1px solid var(--border)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...TH, width: 90 }}>Mode</th>
                  <th style={TH}>Reasoning Depth</th>
                  <th style={{ ...TH, width: 110 }}>Speed</th>
                  <th style={TH}>Best For</th>
                </tr>
              </thead>
              <tbody>
                {MODE_ORDER.map((modeKey, idx) => {
                  const d = MODE_DETAILS[modeKey];
                  if (!d) return null;
                  const isLast = idx === MODE_ORDER.length - 1;
                  return (
                    <tr key={modeKey}>
                      <td style={isLast ? TDlast : TD}><span style={{ fontWeight: 700, color: d.color }}>{d.icon} {d.name}</span></td>
                      <td style={{ ...(isLast ? TDlast : TD), color: 'var(--text-secondary)', lineHeight: 1.5 }}>{d.reasoning}</td>
                      <td style={isLast ? TDlast : TD}><span style={{ fontSize: 12, fontWeight: 600, color: d.color }}>{d.speed}</span></td>
                      <td style={{ ...(isLast ? TDlast : TD), color: 'var(--text-muted)', fontSize: 12 }}>{d.best_for}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td style={TDlast}><span style={{ fontWeight: 700, color: 'var(--accent)' }}>🤖 Auto</span></td>
                  <td style={{ ...TDlast, color: 'var(--text-secondary)', lineHeight: 1.5 }}>Routes each message to the best mode automatically — free for quick answers, Pro for complex tasks.</td>
                  <td style={TDlast}><span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>Adaptive</span></td>
                  <td style={{ ...TDlast, color: 'var(--text-muted)', fontSize: 12 }}>Let SUNy decide</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* ── Section 2: Regular vs PRO ── */}
          <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>👤 Regular vs ⚡ PRO</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.6 }}>
            Both user types access all 4 modes equally. The difference is daily message limits and PRO-exclusive feature access.
          </p>
          <div style={{ overflowX: 'auto', marginBottom: proOnlyFeatures.length > 0 ? 32 : 48, borderRadius: 10, border: '1px solid var(--border)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={TH}></th>
                  <th style={{ ...TH, color: '#9ca3af' }}>👤 Regular</th>
                  <th style={{ ...TH, color: 'var(--accent)' }}>⚡ PRO</th>
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    label: 'Daily Messages',
                    regular: regularDailyLimit ? `${regularDailyLimit} messages / day` : 'Limited (set by admin)',
                    pro: 'Unlimited',
                    proHighlight: true,
                  },
                  { label: 'Reasoning Modes', regular: 'All 4 (Free, Fast, Smart, Pro)', pro: 'All 4 (Free, Fast, Smart, Pro)', proHighlight: false },
                  { label: 'Auto Mode', regular: '✓', pro: '✓', proHighlight: false },
                  { label: 'Pay-per-use Credits', regular: '✓', pro: '✓', proHighlight: false },
                  { label: 'Local File Access', regular: '✓', pro: '✓', proHighlight: false },
                  { label: 'AI Memories & Style Learning', regular: '✓', pro: '✓', proHighlight: false },
                  { label: 'Git Checkpoints & Rollback', regular: '✓', pro: '✓', proHighlight: false },
                  { label: 'Token Saving Engine', regular: '✓', pro: '✓', proHighlight: false },
                  { label: 'PRO-Exclusive Features', regular: '—', pro: proOnlyFeatures.length > 0 ? `✓ All ${proOnlyFeatures.length} PRO features (see below)` : '✓ All PRO features', proHighlight: true },
                ].map((row, idx, arr) => {
                  const isLast = idx === arr.length - 1;
                  return (
                    <tr key={row.label}>
                      <td style={{ ...(isLast ? TDlast : TD), fontWeight: 600 }}>{row.label}</td>
                      <td style={{ ...(isLast ? TDlast : TD), color: 'var(--text-secondary)' }}>{row.regular}</td>
                      <td style={{ ...(isLast ? TDlast : TD), color: row.proHighlight ? 'var(--success, #22c55e)' : 'var(--text-secondary)', fontWeight: row.proHighlight ? 600 : 400 }}>{row.pro}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── Section 3: PRO Feature Cards ── */}
          {proOnlyFeatures.length > 0 && (<>
            <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>⚡ PRO-Exclusive Features</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.6 }}>
              Only available to PRO users, regardless of credits.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14, marginBottom: 40 }}>
              {proOnlyFeatures.map(f => (
                <div key={f.key} style={{ padding: '16px 18px', background: 'var(--surface)', border: '1px solid rgba(108,99,255,0.3)', borderRadius: 10, position: 'relative' }}>
                  <div style={{ position: 'absolute', top: 10, right: 10, fontSize: 9, fontWeight: 700, background: 'rgba(108,99,255,0.15)', color: 'var(--accent)', border: '1px solid rgba(108,99,255,0.3)', borderRadius: 4, padding: '2px 6px' }}>PRO ONLY</div>
                  <div style={{ fontSize: 20, marginBottom: 6 }}>{f.label.match(/^\p{Emoji}/u)?.[0] ?? '✦'}</div>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 5, paddingRight: 52 }}>{f.label.replace(/^\p{Emoji}\s*/u, '')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{f.description}</div>
                  {isPro && <div style={{ marginTop: 10, fontSize: 11, color: 'var(--success, #22c55e)', fontWeight: 600 }}>✓ Active on your plan</div>}
                </div>
              ))}
            </div>
          </>)}

          {/* ── Upgrade CTA ── */}
          {!isPro && (
            <div style={{ padding: '24px 28px', background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))', border: '1px solid rgba(108,99,255,0.3)', borderRadius: 12, display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Ready to upgrade to PRO?</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>Unlimited messages + all PRO features. Submit a request and your admin will upgrade your account.</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                <button
                  onClick={requestUpgrade}
                  disabled={upgradeState !== 'idle'}
                  style={{ padding: '10px 24px', borderRadius: 8, border: 'none', cursor: upgradeState !== 'idle' ? 'default' : 'pointer', background: upgradeState === 'sent' ? 'rgba(34,197,94,0.15)' : 'var(--accent)', color: upgradeState === 'sent' ? 'var(--success, #22c55e)' : '#fff', fontSize: 14, fontWeight: 700 }}
                >
                  {upgradeState === 'loading' ? '...' : upgradeState === 'sent' ? '✓ Request Sent' : '⚡ Request PRO Upgrade'}
                </button>
                {upgradeState === 'sent' && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Your admin will review the request.</div>}
              </div>
            </div>
          )}

        </>)}
      </div>
    </div>
  );
}
