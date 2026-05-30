import { useState, useEffect } from 'react';

interface PricingMode {
  mode: string;
  display_name: string;
  description: string;
  model_id: string;
  input_price_per_1m: number;
  output_price_per_1m: number;
  original_input_price_per_1m?: number;
  original_output_price_per_1m?: number;
  savings_pct?: number | null;
}

interface ContactInfo {
  phone: string;
  email: string;
  website: string;
  whatsapp: string;
  support_message: string;
}

function fmtPrice(price: number): string {
  if (!price || isNaN(price)) return '—';
  if (price === 0) return 'Free';
  if (price < 0.01) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(2)}`;
}

const PLAN_FEATURES: Record<string, { name: string; features: string[]; highlight?: string }> = {
  free: {
    name: 'Starter',
    features: [
      'Chat, Q&A, and Code Snippets',
      'Uses fast open-source models',
      'No system or file modifications',
      'No credit card needed',
    ],
  },
  fast: {
    name: 'Fast',
    highlight: 'Popular',
    features: [
      'Everything in Free',
      'Local File Access (Read/Edit/Delete files via browser)',
      'Executes actions automatically',
      'Pay-as-you-go token pricing',
      '✨ Token Saving Engine: dedicated caching system makes SUNy cheaper than using the AI model directly',
    ],
  },
  smart: {
    name: 'Smart',
    features: [
      'Everything in Fast',
      'Vision, Image & Document Uploads',
      'Standard Agentic Self-Healing',
      'Local Project Awareness',
      'Uses DeepSeek Pro/Flash & Claude',
      'Pay-as-you-go token pricing',
      '✨ Token Saving Engine: dedicated caching system makes SUNy cheaper than using the AI model directly',
    ],
  },
  pro: {
    name: 'Professional',
    highlight: 'Most powerful',
    features: [
      'Everything in Smart',
      'Uses DeepSeek Pro + Claude primarily',
      'Unlimited Multi-File Refactoring sweeps',
      'Deep Architectural Code Review',
      'Cross-Project Pattern Blueprints',
      'Sub-agent delegation capability',
      'Priority support',
      '✨ Token Saving Engine: dedicated caching system reduces costs vs using the AI model directly',
    ],
  },
  opus: {
    name: 'OPUS 4.7',
    highlight: '',
    features: [
      'Complicated high level coding',
      'Zero markup on API costs',
      'Intelligent token caching',
      '✨ Token Saving Engine: pay less than official Claude Opus pricing',
    ],
  },
};

const MODE_ICONS: Record<string, string> = { free: '⚡', fast: '🚀', smart: '🧠', pro: '💎', opus: '🔮' };
const MODE_ACCENT: Record<string, string> = {
  free: '#10b981',
  fast: '#f59e0b',
  smart: '#3b82f6',
  pro: '#6c63ff',
  opus: '#a855f7',
};
const MODE_BG: Record<string, string> = {
  free: 'rgba(16,185,129,0.08)',
  fast: 'rgba(245,158,11,0.08)',
  smart: 'rgba(59,130,246,0.08)',
  pro: 'rgba(108,99,255,0.08)',
  opus: 'rgba(168,85,247,0.08)',
};

export default function PricingPlans() {
  const [pricing, setPricing] = useState<PricingMode[]>([]);
  const [contact, setContact] = useState<ContactInfo | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/pricing-public').then(r => r.ok ? r.json() : []).then(d => { if (Array.isArray(d)) setPricing(d); }).catch(() => {});
    fetch('/api/contact').then(r => r.ok ? r.json() : null).then(d => { if (d) setContact(d); }).catch(() => {});
  }, []);

  const priceMap: Record<string, PricingMode> = {};
  for (const p of pricing) priceMap[p.mode] = p;

  return (
    <div className="pricing-page" style={{
      minHeight: '100vh',
      background: 'var(--bg)',
      color: 'var(--text-primary)',
      fontFamily: 'inherit',
    }}>
      <style>{`
        @media (max-width: 760px) {
          .pricing-hero {
            padding: 28px 14px 20px !important;
          }

          .pricing-grid {
            padding: 18px 12px 24px !important;
            gap: 12px !important;
          }

          .pricing-plan-card {
            flex-basis: 100% !important;
          }

          .pricing-compare-shell,
          .pricing-info-shell,
          .pricing-faq-shell {
            padding-left: 12px !important;
            padding-right: 12px !important;
          }
        }
      `}</style>
      {/* ── Hero ── */}
      <div className="pricing-hero" style={{
        textAlign: 'center',
        padding: '48px 20px 32px',
        background: 'linear-gradient(180deg, rgba(108,99,255,0.08) 0%, transparent 100%)',
      }}>
        <h1 style={{ fontSize: 40, fontWeight: 800, marginBottom: 8, letterSpacing: '-0.5px' }}>
          Plans &amp; Pricing
        </h1>
        <p style={{ fontSize: 16, color: 'var(--text-secondary)', maxWidth: 540, margin: '0 auto', lineHeight: 1.7 }}>
          Start for free. Upgrade when you need more power. Every plan is pay-as-you-go — you only pay for what you use.
        </p>
      </div>

      {/* ── Plans Grid ── */}
      <div className="pricing-grid" style={{
        display: 'flex', gap: 20, justifyContent: 'center',
        padding: '32px 24px 48px', maxWidth: 1100, margin: '0 auto',
        flexWrap: 'wrap', alignItems: 'stretch',
      }}>
        {['free', 'fast', 'smart', 'pro', 'opus'].map(mode => {
          const pm = priceMap[mode];
          const plan = PLAN_FEATURES[mode];
          const isFree = mode === 'free';

          return (
            <div
              className="pricing-plan-card"
              key={mode}
              onClick={() => setSelected(selected === mode ? null : mode)}
              style={{
                flex: '1 1 300px', maxWidth: 340, minWidth: 280,
                borderRadius: 12, border: `1px solid ${selected === mode ? MODE_ACCENT[mode] : 'var(--border)'}`,
                background: 'var(--card-bg, var(--bg-secondary))',
                display: 'flex', flexDirection: 'column',
                transition: 'all 0.2s, transform 0.15s',
                cursor: 'pointer',
                position: 'relative',
                outline: selected === mode ? `2px solid ${MODE_ACCENT[mode]}40` : 'none',
                transform: selected === mode ? 'translateY(-4px)' : 'none',
                boxShadow: selected === mode ? `0 8px 32px ${MODE_ACCENT[mode]}20` : '0 1px 3px rgba(0,0,0,0.08)',
              }}
            >
              {/* Badge */}
              {plan.highlight && (
                <div style={{
                  position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)',
                  background: mode === 'pro'
                    ? 'linear-gradient(135deg, #6c63ff, #a78bfa)'
                    : 'linear-gradient(135deg, #f59e0b, #fbbf24)',
                  color: '#fff', fontSize: 11, fontWeight: 700, padding: '4px 16px',
                  borderRadius: 20, whiteSpace: 'nowrap', letterSpacing: '0.3px',
                }}>
                  {plan.highlight}
                </div>
              )}

              {/* Header */}
              <div style={{
                padding: '32px 24px 20px',
                borderBottom: '1px solid var(--border)',
                textAlign: 'center',
              }}>
                <span style={{ fontSize: 36, display: 'block', marginBottom: 8 }}>{MODE_ICONS[mode]}</span>
                <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>{plan.name}</h2>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5, minHeight: 40 }}>
                  {pm?.description || (mode === 'free' ? 'Quick tasks & simple questions' : mode === 'fast' ? 'Coding, debugging & everyday tasks' : mode === 'smart' ? 'Complex features & architecture decisions' : 'Maximum power with all features unlocked')}
                </p>

                {/* Daily limit badge */}
                <div style={{ marginTop: 14, display: 'inline-block', padding: '4px 14px', borderRadius: 20, background: MODE_BG[mode], fontSize: 13, fontWeight: 600, color: MODE_ACCENT[mode] }}>
                  {mode === 'free' ? '100 msgs/day' : mode === 'fast' ? '500 msgs/day' : 'Unlimited'}
                </div>

                {/* Token pricing */}
                <div style={{ marginTop: 16 }}>
                  {isFree ? (
                    <div style={{ fontSize: 28, fontWeight: 800, color: MODE_ACCENT[mode] }}>
                      Free
                      <span style={{ fontSize: 14, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>forever</span>
                    </div>
                  ) : (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'center', gap: 20, fontSize: 12 }}>
                        <div>
                          <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 2 }}>Input / 1M tokens</div>
                          <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 15, color: MODE_ACCENT[mode] }}>
                            {pm?.original_input_price_per_1m ? <s style={{ opacity: 0.6, marginRight: 6, fontSize: 13, color: 'var(--text-muted)' }}>{fmtPrice(pm.original_input_price_per_1m)}</s> : null}
                            {pm ? fmtPrice(pm.input_price_per_1m) : '—'}
                          </div>
                        </div>
                        <div>
                          <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 2 }}>Output / 1M tokens</div>
                          <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 15, color: MODE_ACCENT[mode] }}>
                            {pm?.original_output_price_per_1m ? <s style={{ opacity: 0.6, marginRight: 6, fontSize: 13, color: 'var(--text-muted)' }}>{fmtPrice(pm.original_output_price_per_1m)}</s> : null}
                            {pm ? fmtPrice(pm.output_price_per_1m) : '—'}
                          </div>
                        </div>
                      </div>
                      {/* Dynamic savings badge — only shown when effective price < original model price */}
                      {pm?.savings_pct != null && pm.savings_pct > 0 && (
                        <div style={{
                          marginTop: 8,
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          background: 'rgba(16,185,129,0.12)',
                          border: '1px solid rgba(16,185,129,0.35)',
                          borderRadius: 20, padding: '3px 10px',
                          fontSize: 11, fontWeight: 700, color: '#10b981',
                        }}>
                          ✦ Up to {pm.savings_pct}% less than original AI model
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Features */}
              <div style={{ padding: '20px 24px', flex: 1 }}>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {plan.features.map((f, i) => {
                    const isHighlight = mode === 'pro' && i >= 4 && i <= 7;
                    return (
                      <li key={i} style={{
                        display: 'flex', gap: 10, alignItems: 'flex-start',
                        padding: '7px 0', fontSize: 13, lineHeight: 1.5,
                        color: isHighlight ? 'var(--accent)' : 'var(--text-secondary)',
                        fontWeight: isHighlight ? 500 : 400,
                        borderBottom: i < plan.features.length - 1 ? '1px solid var(--border)' : 'none',
                      }}>
                        <span style={{ color: MODE_ACCENT[mode], flexShrink: 0, marginTop: 2 }}>✓</span>
                        <span>{f}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>

              {/* CTA */}
              <div style={{ padding: '16px 24px 24px' }}>
                <button
                  onClick={(e) => { e.stopPropagation(); window.location.href = '/login'; }}
                  style={{
                    width: '100%', padding: '12px 0', borderRadius: 8,
                    background: selected === mode ? MODE_ACCENT[mode] : 'var(--bg-secondary)',
                    color: selected === mode ? '#fff' : 'var(--text-primary)',
                    fontSize: 14, fontWeight: 600, cursor: 'pointer',
                    transition: 'all 0.15s',
                    border: selected === mode ? 'none' : '1px solid var(--border)',
                    fontFamily: 'inherit',
                  }}
                >
                  {selected === mode ? 'Get Started' : 'Select Plan'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Comparison Table ── */}
      <div className="pricing-compare-shell" style={{
        maxWidth: 900, margin: '0 auto', padding: '0 24px 48px',
      }}>
        <h3 style={{ fontSize: 18, fontWeight: 700, textAlign: 'center', marginBottom: 20 }}>
          Feature comparison
        </h3>
        <div className="pricing-compare-wrap table-responsive" style={{
          border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden',
          fontSize: 13,
        }}>
          {/* Header row */}
          <div style={{
            display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr',
            background: 'var(--bg-tertiary, var(--bg-secondary))',
            borderBottom: '2px solid var(--border)',
          }}>
            <div style={{ padding: '10px 16px', fontWeight: 600, color: 'var(--text-muted)', fontSize: 12 }}>Feature</div>
            <div style={{ padding: '10px 16px', textAlign: 'center', fontWeight: 700, color: '#10b981', fontSize: 12 }}>⚡ Free</div>
            <div style={{ padding: '10px 16px', textAlign: 'center', fontWeight: 700, color: '#f59e0b', fontSize: 12 }}>🚀 Fast</div>
            <div style={{ padding: '10px 16px', textAlign: 'center', fontWeight: 700, color: '#3b82f6', fontSize: 12 }}>🧠 Smart</div>
            <div style={{ padding: '10px 16px', textAlign: 'center', fontWeight: 700, color: '#6c63ff', fontSize: 12 }}>💎 Pro</div>
            <div style={{ padding: '10px 16px', textAlign: 'center', fontWeight: 700, color: '#a855f7', fontSize: 12 }}>🔮 Opus</div>
          </div>
          {[
            {
              label: 'Input price / 1M tokens',
              free: priceMap['free'] ? fmtPrice(priceMap['free'].input_price_per_1m) : '—',
              fast: priceMap['fast'] ? fmtPrice(priceMap['fast'].input_price_per_1m) : '—',
              smart: priceMap['smart'] ? fmtPrice(priceMap['smart'].input_price_per_1m) : '—',
              pro: priceMap['pro'] ? fmtPrice(priceMap['pro'].input_price_per_1m) : '—',
              opus: priceMap['opus'] ? fmtPrice(priceMap['opus'].input_price_per_1m) : '—',
            },
            {
              label: 'Output price / 1M tokens',
              free: priceMap['free'] ? fmtPrice(priceMap['free'].output_price_per_1m) : '—',
              fast: priceMap['fast'] ? fmtPrice(priceMap['fast'].output_price_per_1m) : '—',
              smart: priceMap['smart'] ? fmtPrice(priceMap['smart'].output_price_per_1m) : '—',
              pro: priceMap['pro'] ? fmtPrice(priceMap['pro'].output_price_per_1m) : '—',
              opus: priceMap['opus'] ? fmtPrice(priceMap['opus'].output_price_per_1m) : '—',
            },
            { label: 'Daily message limit', free: '100/day', fast: '500/day', smart: 'Unlimited', pro: 'Unlimited', opus: 'Unlimited' },
            { label: 'Token pricing', free: 'Free', fast: 'Per token', smart: 'Per token', pro: 'Per token', opus: 'Per token' },
            { label: 'Web search', free: '✓', fast: '✓', smart: '✓', pro: '✓', opus: '✓' },
            { label: 'Vision / Image analysis', free: '—', fast: '✓', smart: '✓', pro: '✓', opus: '✓' },
            { label: 'File editing tools', free: '—', fast: '✓', smart: '✓', pro: '✓', opus: '✓' },
            { label: 'Git checkpoints', free: '—', fast: '✓', smart: '✓', pro: '✓', opus: '✓' },
            { label: 'Memory (save/recall)', free: '—', fast: '✓', smart: '✓', pro: '✓', opus: '✓' },
            { label: 'Lint self-correction', free: '—', fast: '✓', smart: '✓', pro: '✓', opus: '✓' },
            { label: 'Extended reasoning steps', free: '—', fast: '—', smart: '✓', pro: '✓', opus: '✓' },
            { label: 'Architecture-aware planning', free: '—', fast: '—', smart: '✓', pro: '✓', opus: '✓' },
            { label: 'Test self-correction', free: '—', fast: '—', smart: '—', pro: '✓ (5 retries)', opus: '✓ (5 retries)' },
            { label: 'Hypothesis engine', free: '—', fast: '—', smart: '—', pro: '✓', opus: '✓' },
            { label: 'Self-revision (2nd pass)', free: '—', fast: '—', smart: '—', pro: '✓', opus: '✓' },
            { label: 'Subtask delegation', free: '—', fast: '—', smart: '—', pro: '✓', opus: '✓' },
            { label: 'MCP integration', free: '—', fast: '—', smart: '—', pro: '✓', opus: '✓' },
            { label: 'Priority support', free: '—', fast: '—', smart: '—', pro: '✓', opus: '✓' },
          ].map((row, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr',
              borderBottom: i < 15 ? '1px solid var(--border)' : 'none',
              background: i % 2 === 0 ? 'var(--bg-secondary)' : 'transparent',
            }}>
              <div style={{ padding: '10px 16px', fontWeight: 500, color: 'var(--text-primary)' }}>{row.label}</div>
              <div style={{ padding: '10px 16px', textAlign: 'center', color: 'var(--text-muted)' }}>{row.free}</div>
              <div style={{ padding: '10px 16px', textAlign: 'center', color: 'var(--text-muted)' }}>{row.fast}</div>
              <div style={{ padding: '10px 16px', textAlign: 'center', color: '#3b82f6', fontWeight: 500 }}>{row.smart}</div>
              <div style={{ padding: '10px 16px', textAlign: 'center', color: 'var(--accent)', fontWeight: 500 }}>{row.pro}</div>
              <div style={{ padding: '10px 16px', textAlign: 'center', color: '#a855f7', fontWeight: 500 }}>{row.opus}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── PRO Account Upgrade Pitch ── */}
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '0 24px 40px' }}>
        <div style={{
          borderRadius: 14, border: '1px solid rgba(108,99,255,0.45)',
          background: 'linear-gradient(135deg, rgba(108,99,255,0.08) 0%, rgba(167,139,250,0.05) 100%)',
          padding: '28px 28px 24px', position: 'relative', overflow: 'hidden',
        }}>
          <div style={{ position: 'absolute', top: 0, right: 0, width: 180, height: 180, borderRadius: '50%', background: 'rgba(108,99,255,0.06)', transform: 'translate(40%,-40%)' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 22 }}>⚡</span>
            <h3 style={{ fontSize: 20, fontWeight: 800, margin: 0, color: 'var(--accent)' }}>Upgrade to PRO</h3>
            <span style={{ fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: 'rgba(108,99,255,0.2)', color: 'var(--accent)', border: '1px solid rgba(108,99,255,0.4)' }}>ACCOUNT TIER</span>
          </div>
          <div style={{ marginBottom: 16 }}>
            <span style={{ fontSize: 32, fontWeight: 800, color: 'var(--text-primary)' }}>$15</span>
            <span style={{ fontSize: 16, color: 'var(--text-secondary)', marginLeft: 4 }}>/month</span>
            <span style={{ display: 'inline-block', marginLeft: 10, fontSize: 12, color: 'var(--text-muted)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px' }}>
              * $29 first month, $15 thereafter
            </span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 16, marginTop: 0 }}>
            Unlock exclusive PRO-only features on top of your existing pay-as-you-go token plan.
            The PRO account tier gives you access to advanced AI capabilities not available to regular users.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
            {[
              { icon: '🔭', label: 'Advanced Visual Portal' },
              { icon: '⚡', label: 'Parallel Agent Swarm' },
              { icon: '🔬', label: 'Parallel Hypothesis Testing' },
              { icon: '🚧', label: 'Scheduled Agents' },
            ].map(f => (
              <div key={f.label} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, background: 'rgba(108,99,255,0.1)', border: '1px solid rgba(108,99,255,0.2)', fontSize: 12, fontWeight: 500 }}>
                <span>{f.icon}</span><span>{f.label}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            To upgrade, contact your administrator or click <strong>⚡ Upgrade to PRO</strong> in the chat interface.<br />
            Token usage is still billed separately on a pay-as-you-go basis.
          </div>
        </div>
      </div>

      {/* ── How pricing works ── */}
      <div className="pricing-info-shell" style={{
        maxWidth: 700, margin: '0 auto', padding: '0 24px 48px', textAlign: 'center',
      }}>
        <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>How token pricing works</h3>
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, padding: '24px', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 20, flexShrink: 0 }}>💰</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Add credits to your wallet</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                Top up your wallet with any amount. Credits never expire.
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 20, flexShrink: 0 }}>⚖️</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Pay per token, per task</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                You are charged based on how many tokens the AI processes. Longer tasks cost more, simple tasks cost less.
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 20, flexShrink: 0 }}>🔒</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>No surprises</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                The Planner mode shows estimated cost before each task. You approve before tokens are spent.
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── FAQ / Contact ── */}
      <div className="pricing-faq-shell" style={{
        maxWidth: 700, margin: '0 auto', padding: '0 24px 48px', textAlign: 'center',
      }}>
        <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Questions?</h3>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 20 }}>
          The Starter plan is always free — no credit card needed. Fast, Smart, and Professional plans are pay-as-you-go.{' '}
          Unused credits never expire.
        </p>
        {contact && (
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 20 }}>
            {contact.email && <a href={`mailto:${contact.email}`} className="btn btn-secondary" style={{ fontSize: 13 }}>📧 {contact.email}</a>}
            {contact.whatsapp && <a href={`https://wa.me/${contact.whatsapp.replace(/\D/g,'')}`} target="_blank" rel="noreferrer" className="btn btn-secondary" style={{ fontSize: 13 }}>💬 WhatsApp</a>}
          </div>
        )}
        <a href="/login" style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none' }}>
          ← Back to sign in
        </a>
      </div>

      {/* Footer */}
      <div style={{
        textAlign: 'center', padding: '16px 20px', fontSize: 12,
        color: 'var(--text-muted)', borderTop: '1px solid var(--border)',
      }}>
        SUNy — Consider it done! &nbsp;·&nbsp; © {new Date().getFullYear()}
      </div>
    </div>
  );
}
