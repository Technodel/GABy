import { useState, useEffect } from 'react';
import ModelPicker from '../components/ModelPicker';

interface PricingMode {
  mode: string;
  display_name: string;
  description: string;
  markup_formula: string;
  input_token_base_cost: number;
  output_token_base_cost: number;
  model_id: string;
  global_max_tokens: number | null;
  is_active: number;
}

const FRIENDLY_LABELS: Record<string, string> = { free: '⚡ Free Mode', fast: '🚀 Fast Mode', pro: '🧠 Pro Mode' };

function fmtCost(cost: number | undefined | null): string {
  if (cost == null || isNaN(cost)) return '—';
  if (cost === 0) return 'free';
  const perM = cost * 1_000_000;
  return `$${perM < 1 ? perM.toFixed(4) : perM.toFixed(2)} / 1M tokens`;
}

export default function AdminPricing() {
  const [modes, setModes] = useState<PricingMode[]>([]);
  const [editing, setEditing] = useState<Record<string, Partial<PricingMode>>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [activeKeyModes, setActiveKeyModes] = useState<Set<string>>(new Set());

  useEffect(() => { loadPricing(); loadActiveKeys(); }, []);

  async function loadActiveKeys() {
    const res = await fetch('/admin/api/api-keys', { credentials: 'include' });
    if (res.ok) {
      const keys: Array<{ mode: string; is_active: number }> = await res.json();
      setActiveKeyModes(new Set(keys.filter(k => k.is_active === 1).map(k => k.mode)));
    }
  }

  async function loadPricing() {
    const res = await fetch('/admin/api/pricing', { credentials: 'include' });
    if (res.ok) setModes(await res.json());
  }

  function getField<K extends keyof PricingMode>(mode: string, field: K, fallback: PricingMode[K]): PricingMode[K] {
    return (editing[mode]?.[field] as PricingMode[K]) ?? fallback;
  }

  function setField(mode: string, field: keyof PricingMode, value: string | number | null) {
    setEditing(prev => ({ ...prev, [mode]: { ...prev[mode], [field]: value } }));
  }

  async function saveMode(modeRow: PricingMode) {
    const patch = editing[modeRow.mode] || {};
    const res = await fetch(`/admin/api/pricing/${modeRow.mode}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      setSaved(p => ({ ...p, [modeRow.mode]: true }));
      setTimeout(() => setSaved(p => ({ ...p, [modeRow.mode]: false })), 2000);
      loadPricing();
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>💰 Pricing</h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 24 }}>
        Configure per-mode pricing. The markup formula is evaluated with <code>input_tokens</code> and <code>output_tokens</code> as variables.
        Users only see their credit balance — they never see token counts or formulas.
      </p>

      {modes.map(m => (
        <div key={m.mode} className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ fontWeight: 600, fontSize: 16 }}>
              {FRIENDLY_LABELS[m.mode] || m.mode}
            </h3>
            <span className={`badge ${m.is_active ? 'badge-green' : 'badge-amber'}`}>
              {m.is_active ? 'Active' : 'Inactive'}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Description (shown to users)</label>
              <input
                value={(getField(m.mode, 'description', m.description) as string) ?? ''}
                onChange={e => setField(m.mode, 'description', e.target.value)}
                placeholder="Short description visible to users when selecting this mode"
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Display Name</label>
              <input
                value={getField(m.mode, 'display_name', m.display_name) as string}
                onChange={e => setField(m.mode, 'display_name', e.target.value)}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Global Max Tokens (blank = unlimited)</label>
              <input
                type="number"
                value={getField(m.mode, 'global_max_tokens', m.global_max_tokens) ?? ''}
                onChange={e => setField(m.mode, 'global_max_tokens', e.target.value ? parseInt(e.target.value, 10) : null)}
                placeholder="Unlimited"
              />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Model ID</label>
              {!activeKeyModes.has(m.mode) && (
                <div style={{ padding: '8px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', fontSize: 13, color: '#ef4444', marginBottom: 8 }}>
                  ⚠️ No active API key for this mode. Add a compatible key in the <strong>API Keys</strong> section before selecting a model.
                </div>
              )}
              <div style={{ opacity: activeKeyModes.has(m.mode) ? 1 : 0.45, pointerEvents: activeKeyModes.has(m.mode) ? 'auto' : 'none' }}>
                <ModelPicker
                  value={getField(m.mode, 'model_id', m.model_id) as string}
                  onChange={(id, model) => {
                    setField(m.mode, 'model_id', id);
                    if (model) {
                      setField(m.mode, 'input_token_base_cost', model.inputCost);
                      setField(m.mode, 'output_token_base_cost', model.outputCost);
                    }
                  }}
                />
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Select from the model browser or type a model ID manually. Selecting will auto-fill token costs.
              </div>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Markup Formula</label>
              <input
                value={getField(m.mode, 'markup_formula', m.markup_formula) as string}
                onChange={e => setField(m.mode, 'markup_formula', e.target.value)}
                placeholder="e.g. (input_tokens * 0.000003 + output_tokens * 0.000015) * 1.5"
                style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}
              />
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Variables: <code>input_tokens</code>, <code>output_tokens</code>. Result is the dollar cost charged to the user.
              </div>
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Input Token Cost — from provider</label>
              <div style={{ padding: '7px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2, var(--surface))', border: '1px solid var(--border)', fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: 'var(--text-secondary)' }}>
                {fmtCost(getField(m.mode, 'input_token_base_cost', m.input_token_base_cost) as number)}
              </div>
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Output Token Cost — from provider</label>
              <div style={{ padding: '7px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2, var(--surface))', border: '1px solid var(--border)', fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: 'var(--text-secondary)' }}>
                {fmtCost(getField(m.mode, 'output_token_base_cost', m.output_token_base_cost) as number)}
              </div>
            </div>
            <div style={{ gridColumn: '1 / -1', padding: '12px 16px', background: 'var(--surface)', borderRadius: 'var(--radius)', border: '1px solid var(--accent)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', marginBottom: 8 }}>Final Sale Price (What users pay)</div>
              <div style={{ display: 'flex', gap: 24, fontSize: 13 }}>
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Input: </span>
                  <span style={{ fontWeight: 700, fontFamily: 'monospace' }}>
                    {(() => {
                      try {
                        const inputCost = (getField(m.mode, 'input_token_base_cost', m.input_token_base_cost) as number) * 1_000_000;
                        const formula = (getField(m.mode, 'markup_formula', m.markup_formula) as string) || 'cost';
                        // A quick naive eval just for display. The real eval uses mathjs.
                        const final = Function('cost', 'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', `return ${formula}`)(inputCost, 1_000_000, 0, 0, 0);
                        return `$${final.toFixed(2)} / 1M`;
                      } catch { return 'Invalid formula'; }
                    })()}
                  </span>
                </div>
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Output: </span>
                  <span style={{ fontWeight: 700, fontFamily: 'monospace' }}>
                    {(() => {
                      try {
                        const outputCost = (getField(m.mode, 'output_token_base_cost', m.output_token_base_cost) as number) * 1_000_000;
                        const formula = (getField(m.mode, 'markup_formula', m.markup_formula) as string) || 'cost';
                        const final = Function('cost', 'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', `return ${formula}`)(outputCost, 0, 1_000_000, 0, 0);
                        return `$${final.toFixed(2)} / 1M`;
                      } catch { return 'Invalid formula'; }
                    })()}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={() => saveMode(m)}>
              {saved[m.mode] ? '✓ Saved!' : 'Save Changes'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
