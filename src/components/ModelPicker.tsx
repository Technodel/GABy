import { useState, useEffect, useRef } from 'react';
import { Search, X, Lock } from 'lucide-react';

interface ModelInfo {
  id: string;
  provider: string;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number | null;
  cacheWriteCost: number | null;
  contextTokens: number | null;
  hasApiKey: boolean;
}

interface ModelPickerProps {
  value: string;
  onChange: (id: string, model?: ModelInfo) => void;
  placeholder?: string;
}

export default function ModelPicker({ value, onChange, placeholder }: ModelPickerProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || models.length > 0) return;
    setLoading(true);
    setError('');
    fetch('/admin/api/models', { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setModels(data);
        else setError(data.error || 'Failed to load models');
      })
      .catch(() => setError('Network error'))
      .finally(() => setLoading(false));
  }, [open]);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = search
    ? models.filter(m => m.id.toLowerCase().includes(search.toLowerCase()) || m.provider.toLowerCase().includes(search.toLowerCase()))
    : models;

  function fmt(cost: number) {
    if (cost === 0) return 'free';
    if (cost < 0.000001) return `$${(cost * 1_000_000).toFixed(2)}/M`;
    return `$${cost.toFixed(6)}`;
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder ?? 'Model ID (e.g. claude-3-5-haiku-20241022)'}
          style={{ flex: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}
          onFocus={() => setOpen(true)}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setOpen(o => !o)}
          title="Browse models"
        >
          <Search size={13} />
        </button>
      </div>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 999,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)', marginTop: 4,
          maxHeight: 400, display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
            <Search size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search models..."
              style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 13 }}
            />
            {search && <X size={13} style={{ cursor: 'pointer', color: 'var(--text-muted)' }} onClick={() => setSearch('')} />}
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {loading && <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading models...</div>}
            {error && <div style={{ padding: 16, color: 'var(--error)', fontSize: 13 }}>{error}</div>}
            {!loading && !error && filtered.length === 0 && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No models found</div>
            )}
            {filtered.slice(0, 150).map(m => {
              const locked = !m.hasApiKey;
              return (
                <div
                  key={`${m.provider}/${m.id}`}
                  onClick={() => {
                    if (locked) return;
                    onChange(m.id, m); setOpen(false); setSearch('');
                  }}
                  title={locked ? `No active API key for ${m.provider} — add one in API Keys` : undefined}
                  style={{
                    padding: '8px 12px',
                    cursor: locked ? 'not-allowed' : 'pointer',
                    borderBottom: '1px solid var(--border)',
                    opacity: locked ? 0.45 : 1,
                    background: value === m.id ? 'var(--accent-dim, rgba(99,102,241,0.1))' : undefined,
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}
                  onMouseEnter={e => {
                    if (!locked) (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-hover, rgba(255,255,255,0.05))';
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLDivElement).style.background = value === m.id ? 'var(--accent-dim, rgba(99,102,241,0.1))' : '';
                  }}
                >
                  {locked && <Lock size={11} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, fontWeight: 600 }}>{m.id}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>{m.provider}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      in: {fmt(m.inputCost)} · out: {fmt(m.outputCost)}
                      {m.contextTokens ? ` · ${(m.contextTokens / 1000).toFixed(0)}k ctx` : ''}
                      {m.cacheReadCost != null ? ` · cache↓ ${fmt(m.cacheReadCost)}` : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
