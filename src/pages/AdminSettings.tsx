import { useState, useEffect } from 'react';

type EditFormat = 'tool-call' | 'diff' | 'whole' | 'architect';

interface Settings {
  allow_registration: boolean;
  dark_mode: boolean;
  prompt_caching_enabled: boolean;
  edit_format: EditFormat;
}

export default function AdminSettings() {
  const [settings, setSettings] = useState<Settings>({
    allow_registration: false,
    dark_mode: true,
    prompt_caching_enabled: true,
    edit_format: 'tool-call',
  });
  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [pwdError, setPwdError] = useState('');
  const [pwdSuccess, setPwdSuccess] = useState('');
  const [settingsSaved, setSettingsSaved] = useState(false);

  useEffect(() => {
    fetch('/admin/api/settings', { credentials: 'include' })
      .then(r => r.json())
      .then(raw => setSettings(prev => ({
        ...prev,
        allow_registration: raw.allow_registration === 'true',
        dark_mode: raw.dark_mode === 'true',
        prompt_caching_enabled: raw.prompt_caching_enabled !== 'false',
        edit_format: (['tool-call', 'diff', 'whole', 'architect'].includes(raw.edit_format) ? raw.edit_format : 'tool-call') as EditFormat,
      })));
  }, []);

  function toggle(key: keyof Settings) {
    setSettings(prev => ({ ...prev, [key]: !prev[key] }));
  }

  async function saveSettings() {
    const res = await fetch('/admin/api/settings', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    if (res.ok) {
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    }
  }

  async function changePassword() {
    setPwdError(''); setPwdSuccess('');
    if (newPwd !== confirmPwd) { setPwdError('Passwords do not match'); return; }
    if (newPwd.length < 6) { setPwdError('Password must be at least 6 characters'); return; }
    const res = await fetch('/admin/api/settings/change-password', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: currentPwd, new_password: newPwd }),
    });
    const data = await res.json();
    if (res.ok) {
      setPwdSuccess('Password changed successfully');
      setCurrentPwd(''); setNewPwd(''); setConfirmPwd('');
    } else {
      setPwdError(data.error || 'Failed to change password');
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 24 }}>âš™ï¸ Settings</h1>

      {/* General Settings */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ fontWeight: 600, marginBottom: 16 }}>General</h3>

        {[
          { key: 'allow_registration' as const, label: 'Allow New User Registration', desc: 'When off, only admin can create users.' },
          { key: 'dark_mode' as const, label: 'Default Dark Mode', desc: 'Default appearance for new users.' },
          { key: 'prompt_caching_enabled' as const, label: 'ðŸ§  Prompt Caching', desc: 'Caches static context (system prompt, project map, open files) to cut input costs by up to 90% on repeat turns. Works with all supported models.' },
        ].map(s => (
          <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
            <div>
              <div style={{ fontWeight: 500, fontSize: 14 }}>{s.label}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{s.desc}</div>
            </div>
            <input type="checkbox" className="toggle" checked={settings[s.key]} onChange={() => toggle(s.key)} />
          </div>
        ))}

        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" onClick={saveSettings}>
            {settingsSaved ? 'âœ“ Saved!' : 'Save Settings'}
          </button>
        </div>
      </div>
      {/* Edit Format */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ fontWeight: 600, marginBottom: 4 }}>âœï¸ Edit Format</h3>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
          Controls how GABy makes changes to your code files. Choose the strategy that best matches your subscription plan and the size of your project.
        </p>

        {([
          { value: 'tool-call', label: 'ðŸ"§ Smart Edit (Recommended)', desc: 'GABy reads and edits only the exact parts of files it needs to change. Most accurate, lowest token usage — changes are precise and safe.' },
          { value: 'diff', label: 'ðŸ"„ Patch Mode', desc: 'GABy describes the exact lines to find and replace in each file. Great for plans with limited tokens — uses slightly fewer tokens than Smart Edit, works well on all plan levels.' },
          { value: 'whole', label: 'ðŸ"‹ Full Rewrite', desc: 'GABy rewrites the complete file from scratch each time. Simple and straightforward, but uses the most tokens. Best for small files or quick prototypes.' },
          { value: 'architect', label: 'ðŸ›ï¸ Architect (Best Quality)', desc: 'Two-step process: GABy first thinks through the full plan, then executes every change carefully. Highest quality for large or complex projects — uses roughly 2× tokens per task.' },
        ] as { value: EditFormat; label: string; desc: string }[]).map(opt => (
          <div
            key={opt.value}
            onClick={() => setSettings(prev => ({ ...prev, edit_format: opt.value }))}
            style={{
              padding: '12px 14px', marginBottom: 8, borderRadius: 8, cursor: 'pointer',
              border: `2px solid ${settings.edit_format === opt.value ? 'var(--accent)' : 'var(--border)'}`,
              background: settings.edit_format === opt.value ? 'var(--accent-dim, rgba(99,102,241,0.08))' : 'var(--surface)',
              transition: 'border-color 0.15s',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>{opt.label}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{opt.desc}</div>
          </div>
        ))}

        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" onClick={saveSettings}>
            {settingsSaved ? 'âœ" Saved!' : 'Save Edit Format'}
          </button>
        </div>
      </div>
      {/* Change Admin Password */}
      <div className="card">
        <h3 style={{ fontWeight: 600, marginBottom: 16 }}>ðŸ” Change Admin Password</h3>

        {pwdError && <div style={{ color: 'var(--error)', fontSize: 13, marginBottom: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.1)', borderRadius: 6 }}>{pwdError}</div>}
        {pwdSuccess && <div style={{ color: 'var(--success)', fontSize: 13, marginBottom: 12, padding: '8px 12px', background: 'rgba(34,197,94,0.1)', borderRadius: 6 }}>{pwdSuccess}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Current Password</label>
            <input type="password" value={currentPwd} onChange={e => setCurrentPwd(e.target.value)} placeholder="Enter current password" />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>New Password</label>
            <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} placeholder="New password (min 6 chars)" />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Confirm New Password</label>
            <input type="password" value={confirmPwd} onChange={e => setConfirmPwd(e.target.value)} placeholder="Confirm new password" />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={changePassword}>Change Password</button>
          </div>
        </div>
      </div>
    </div>
  );
}
