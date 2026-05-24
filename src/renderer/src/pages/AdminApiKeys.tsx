import { useState, useEffect } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import ModelPicker from '../components/ModelPicker';

interface ApiKey {
  id: number;
  provider: string;
  mode: string;
  is_active: number;
  label: string | null;
  priority: number;
  model_id_override: string | null;
  key_value: string;
  base_cost_prompt?: number;
  base_cost_completion?: number;
  sale_price_prompt?: number;
  sale_price_completion?: number;
}

const PROVIDERS = ['Anthropic', 'DeepSeek', 'Groq', 'OpenRouter', 'OpenAI', 'Gemini', 'Ollama', 'OpenAI-compatible', 'HuggingFace', 'Mistral', 'Cohere', 'Together', 'Perplexity'];
const MODES = [
  { value: 'free', label: '⚡ Free Mode' },
  { value: 'fast', label: '🚀 Fast Mode' },
  { value: 'smart', label: '🧠 Smart Mode' },
  { value: 'pro', label: '💎 Pro Mode' },
];

export default function AdminApiKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [provider, setProvider] = useState(PROVIDERS[0]);
  const [keyValue, setKeyValue] = useState('');
  const [mode, setMode] = useState('fast');
  const [label, setLabel] = useState('');
  const [priority, setPriority] = useState(1);
  const [modelIdOverride, setModelIdOverride] = useState('');
  const [baseCostPrompt, setBaseCostPrompt] = useState(0);
const [baseCostCompletion, setBaseCostCompletion] = useState(0);
const [salePricePrompt, setSalePricePrompt] = useState(0);
const [salePriceCompletion, setSalePriceCompletion] = useState(0);
const [error, setError] = useState('');
  const [modelBrowserOpen, setModelBrowserOpen] = useState(false);
  const [browseSearch, setBrowseSearch] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadKeys(); }, []);

  async function loadKeys() {
    setLoadError('');
    setLoading(true);
    try {
      const res = await fetch('/admin/api/api-keys', { credentials: 'include' });
      if (res.ok) setKeys(await res.json());
      else setLoadError(`Failed to load API keys (HTTP ${res.status})`);
    } catch {
      setLoadError('Network error — is the server running?');
    } finally {
      setLoading(false);
    }
  }

  async function addKey() {
    setError('');
    const res = await fetch('/admin/api/api-keys', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, key_value: keyValue, mode, label: label || undefined, priority, model_id_override: modelIdOverride || undefined, base_cost_prompt: baseCostPrompt, base_cost_completion: baseCostCompletion, sale_price_prompt: salePricePrompt, sale_price_completion: salePriceCompletion }),
    });
    const data = await res.json();
    if (res.ok) {
      setShowAdd(false);
      setKeyValue(''); setLabel(''); setPriority(1); setModelIdOverride(''); setBaseCostPrompt(0); setBaseCostCompletion(0); setSalePricePrompt(0); setSalePriceCompletion(0);
      loadKeys();
    } else {
      setError(data.error || 'Failed to add key');
    }
  }

  async function deleteKey(id: number) {
    if (!confirm('Delete this API key?')) return;
    await fetch(`/admin/api/api-keys/${id}`, { method: 'DELETE', credentials: 'include' });
    loadKeys();
  }

  const modeLabel = (m: string) => MODES.find(x => x.value === m)?.label || m;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>🔑 API Keys</h1>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
          <Plus size={14} /> Add Key
        </button>
      </div>

      <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 'var(--radius-sm)', background: 'rgba(108,99,255,0.06)', border: '1px solid var(--accent)', fontSize: 13, color: 'var(--text-secondary)' }}>
        Each mode (Free / Fast / Pro) should have exactly one active key. Adding a new key for a mode deactivates the previous one automatically.
      </div>

      {loadError && (
        <div style={{ padding: '10px 14px', marginBottom: 16, borderRadius: 'var(--radius-sm)', background: 'rgba(239,68,68,0.08)', border: '1px solid var(--error)', fontSize: 13, color: 'var(--error)' }}>
          {loadError}
        </div>
      )}
      <div className="card table-responsive" style={{ padding: 0, overflow: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Priority</th>
              <th>Provider</th>
              <th>Key Value</th>
              <th>Label / Model Override</th>
              <th>Mode</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.map(k => (
              <tr key={k.id}>
                <td style={{ fontWeight: 600, color: 'var(--accent)', textAlign: 'center' }}>{k.priority}</td>
                <td style={{ fontWeight: 500 }}>{k.provider}</td>
                <td style={{ fontFamily: 'monospace', maxWidth: 200, WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', display: '-webkit-box', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k.key_value}</td>
                <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  {k.label && <div>{k.label}</div>}
                  {k.model_id_override && <div style={{ fontFamily: 'monospace' }}>{k.model_id_override}</div>}
                  {!k.label && !k.model_id_override && '—'}
                </td>
                <td>{modeLabel(k.mode)}</td><td style={{fontFamily:'monospace',fontSize:12,color:'var(--text-muted)'}}>/M</td><td style={{fontFamily:'monospace',fontSize:12,color:'var(--text-muted)'}}>/M</td>
                <td>
                  <span className={`badge ${k.is_active ? 'badge-green' : 'badge-amber'}`}>
                    {k.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td>
                  <button className="btn btn-sm btn-danger" onClick={() => deleteKey(k.id)}>
                    <Trash2 size={12} /> Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            Loading API keys...
          </div>
        )}
        {!loading && keys.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            No API keys configured yet. Add one to enable SUNy.
          </div>
        )}
      </div>

      {showAdd && (
        <div className="modal-overlay" onClick={() => setShowAdd(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 className="modal-title" style={{ margin: 0 }}>Add API Key</h3>
              <button className="btn btn-icon btn-secondary btn-sm" onClick={() => setShowAdd(false)}><X size={14} /></button>
            </div>
            {error && <div style={{ color: 'var(--error)', fontSize: 13, marginBottom: 12 }}>{error}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Provider</label>
                <select value={provider} onChange={e => setProvider(e.target.value)}>
                  {PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Mode</label>
                <select value={mode} onChange={e => setMode(e.target.value)}>
                  {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Label (optional)</label>
                <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Anthropic – Pro" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Sale Price / 1M Prompts ($)</label>
                  <input type="number" step="0.0001" value={salePricePrompt} onChange={e => setSalePricePrompt(parseFloat(e.target.value) || 0)} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Sale Price / 1M Completions ($)</label>
                  <input type="number" step="0.0001" value={salePriceCompletion} onChange={e => setSalePriceCompletion(parseFloat(e.target.value) || 0)} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Priority</label>
                  <input type="number" min={1} value={priority} onChange={e => setPriority(parseInt(e.target.value, 10) || 1)} />
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>1 = primary, 2 = fallback, etc.</div>
                </div>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Model Override (optional)</label>
                  <input value={modelIdOverride} onChange={e => setModelIdOverride(e.target.value)} placeholder="e.g. llama-3.3-70b-versatile" />
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Overrides the mode's default model for this key.</div>
                </div>
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                  {provider === 'Ollama' ? 'Ollama Base URL'
                    : provider === 'OpenAI-compatible' ? 'Endpoint Base URL'
                    : provider === 'HuggingFace' ? 'HF Access Token'
                    : 'API Key'}
                </label>
                <input
                  type={provider === 'Ollama' || provider === 'OpenAI-compatible' || provider === 'HuggingFace' ? 'text' : 'password'}
                  value={keyValue}
                  onChange={e => setKeyValue(e.target.value)}
                  placeholder={provider === 'Ollama' ? 'http://localhost:11434/v1'
                    : provider === 'OpenAI-compatible' ? 'http://localhost:8000/v1'
                    : provider === 'HuggingFace' ? 'hf_xxxxxxxxxxxxxxxxxxxxxxxx'
                    : 'Paste API key here'}
                  autoComplete="off"
                />
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  {provider === 'Ollama'
                    ? 'Default: http://localhost:11434/v1. Change if Ollama is on a different host/port.'
                    : provider === 'OpenAI-compatible'
                    ? 'Your custom model endpoint (vLLM, TGI, llama.cpp, etc.)'
                    : provider === 'HuggingFace'
                    ? 'Free HF Inference API — get a token at huggingface.co/settings/tokens. Set model override to your HF model name.'
                    : 'Stored securely. Never shown again after saving.'}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={addKey}>Save Key</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
