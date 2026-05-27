import { useState, useEffect } from 'react';

interface PlanFeatureFlag {
  key: string;
  plan: string;
  enabled: boolean;
  label: string;
  description: string;
}

const PLANS = ['regular', 'pro'] as const;
const PLAN_LABELS: Record<string, string> = { regular: 'Regular', pro: '⚡ PRO' };

const emptyForm = { key: '', label: '', description: '', proEnabled: true, regularEnabled: false };

export default function AdminPlanFeatures() {
  const [flags, setFlags] = useState<PlanFeatureFlag[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [addError, setAddError] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    const res = await fetch('/admin/api/plan-features', { credentials: 'include' });
    if (res.ok) setFlags(await res.json() as PlanFeatureFlag[]);
  }

  async function toggle(key: string, plan: string, enabled: boolean) {
    const id = `${key}:${plan}`;
    setSaving(id);
    await fetch(`/admin/api/plan-features/${encodeURIComponent(key)}/${plan}`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    await load();
    setSaving(null);
  }

  async function addFeature() {
    setAddError('');
    if (!form.key.trim() || !form.label.trim()) { setAddError('Key and label are required.'); return; }
    setAddBusy(true);
    const res = await fetch('/admin/api/plan-features', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({})) as { error?: string };
      setAddError(d.error ?? 'Failed to add feature');
      setAddBusy(false);
      return;
    }
    await load();
    setForm(emptyForm);
    setShowAdd(false);
    setAddBusy(false);
  }

  async function deleteFeature(key: string) {
    await fetch(`/admin/api/plan-features/${encodeURIComponent(key)}`, { method: 'DELETE', credentials: 'include' });
    setDeleteConfirm(null);
    await load();
  }

  const keys = [...new Set(flags.map(f => f.key))];

  return (
    <div>
      <div style={{ marginBottom: 24, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>🛡️ Plan Features</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14, margin: 0 }}>
            Control which features are available to Regular vs PRO users. Changes appear live on the <strong>PRO Features</strong> page.
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => { setShowAdd(s => !s); setAddError(''); setForm(emptyForm); }}
          style={{ flexShrink: 0 }}
        >
          {showAdd ? '✕ Cancel' : '+ Add Feature'}
        </button>
      </div>

      {/* Add feature form */}
      {showAdd && (
        <div className="card" style={{ marginBottom: 20, border: '1px solid rgba(108,99,255,0.4)', background: 'rgba(108,99,255,0.04)' }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 14 }}>New Plan Feature</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Key (auto-sanitized, e.g. pf_my_feature)</label>
              <input className="input" value={form.key} onChange={e => setForm(f => ({ ...f, key: e.target.value }))} placeholder="pf_my_feature" style={{ fontSize: 13, width: '100%' }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Label (shown in UI, emoji allowed)</label>
              <input className="input" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="🚀 My Feature" style={{ fontSize: 13, width: '100%' }} />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Description (shown to users)</label>
            <input className="input" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Short description of what this feature does." style={{ fontSize: 13, width: '100%' }} />
          </div>
          <div style={{ display: 'flex', gap: 20, marginBottom: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.proEnabled} onChange={e => setForm(f => ({ ...f, proEnabled: e.target.checked }))} />
              Enabled for <span style={{ fontWeight: 600, color: 'var(--accent)' }}>PRO</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.regularEnabled} onChange={e => setForm(f => ({ ...f, regularEnabled: e.target.checked }))} />
              Enabled for <span style={{ fontWeight: 600 }}>Regular</span>
            </label>
          </div>
          {addError && <div style={{ color: 'var(--error)', fontSize: 12, marginBottom: 10 }}>{addError}</div>}
          <button className="btn btn-primary" onClick={addFeature} disabled={addBusy} style={{ fontSize: 13 }}>
            {addBusy ? 'Adding…' : '+ Add Feature'}
          </button>
        </div>
      )}

      {keys.length === 0 ? (
        <div className="card" style={{ color: 'var(--text-muted)', fontSize: 14 }}>
          No plan features found. Run the server once to seed the defaults, or add one above.
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '12px 16px', borderBottom: '1px solid var(--border)', minWidth: 260 }}>Feature</th>
                {PLANS.map(plan => (
                  <th key={plan} style={{ textAlign: 'center', padding: '12px 24px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                    <span style={{
                      display: 'inline-block', padding: '3px 10px', borderRadius: 4, fontSize: 12, fontWeight: 700,
                      background: plan === 'pro' ? 'rgba(108,99,255,0.15)' : 'rgba(100,100,100,0.10)',
                      color: plan === 'pro' ? 'var(--accent)' : 'var(--text-secondary)',
                      border: plan === 'pro' ? '1px solid rgba(108,99,255,0.3)' : '1px solid var(--border)',
                    }}>{PLAN_LABELS[plan]}</span>
                  </th>
                ))}
                <th style={{ textAlign: 'center', padding: '12px 12px', borderBottom: '1px solid var(--border)', width: 48 }} />
              </tr>
            </thead>
            <tbody>
              {keys.map(key => {
                const flagForKey = flags.find(f => f.key === key);
                const isDeleting = deleteConfirm === key;
                return (
                  <tr key={key} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ fontWeight: 500, fontSize: 14 }}>{flagForKey?.label || key}</div>
                      {flagForKey?.description && (
                        <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>{flagForKey.description}</div>
                      )}
                      <div style={{ color: 'var(--text-muted)', fontSize: 10, marginTop: 3, fontFamily: 'monospace' }}>{key}</div>
                    </td>
                    {PLANS.map(plan => {
                      const flag = flags.find(f => f.key === key && f.plan === plan);
                      const enabled = flag?.enabled ?? false;
                      const id = `${key}:${plan}`;
                      const isSaving = saving === id;
                      return (
                        <td key={plan} style={{ textAlign: 'center', padding: '12px 24px' }}>
                          <button
                            onClick={() => toggle(key, plan, !enabled)}
                            disabled={isSaving}
                            title={enabled ? `Disable for ${PLAN_LABELS[plan]}` : `Enable for ${PLAN_LABELS[plan]}`}
                            style={{
                              width: 44, height: 24, borderRadius: 12, border: 'none', cursor: isSaving ? 'wait' : 'pointer',
                              background: enabled ? (plan === 'pro' ? 'var(--accent)' : 'var(--success,#22c55e)') : 'var(--border)',
                              transition: 'background 0.2s', position: 'relative',
                            }}
                          >
                            <span style={{ position: 'absolute', top: 3, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left 0.2s', left: enabled ? 23 : 3 }} />
                          </button>
                        </td>
                      );
                    })}
                    <td style={{ textAlign: 'center', padding: '12px 12px' }}>
                      {isDeleting ? (
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                          <button onClick={() => deleteFeature(key)} style={{ fontSize: 11, background: 'var(--error,#ef4444)', color: '#fff', border: 'none', borderRadius: 4, padding: '3px 8px', cursor: 'pointer' }}>Delete</button>
                          <button onClick={() => setDeleteConfirm(null)} style={{ fontSize: 11, background: 'var(--border)', color: 'var(--text-primary)', border: 'none', borderRadius: 4, padding: '3px 8px', cursor: 'pointer' }}>Cancel</button>
                        </div>
                      ) : (
                        <button onClick={() => setDeleteConfirm(key)} title="Delete this feature" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>🗑</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ marginTop: 20, background: 'rgba(108,99,255,0.04)', borderColor: 'var(--accent)', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
        <strong>How it works:</strong> When a user sends a message, SUNy checks their plan and feature toggles above.
        Disabled features show a locked state in User Settings and a PRO upgrade prompt.
        The public <strong>/pro-features</strong> page is dynamically generated from this list — only features enabled for PRO are shown.
        Assign a user's plan in the <strong>Users</strong> tab.
      </div>
    </div>
  );
}
