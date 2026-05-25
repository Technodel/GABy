import { useState, useEffect } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Summary {
  total_users: number;
  total_sessions: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_write: number;
  total_cache_read: number;
  total_cached_saved: number;
  total_raw_cost: number;
  total_charged: number;
  total_profit: number;
}

interface UserStat {
  user_id: number;
  username: string;
  display_name: string | null;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  cached_tokens_saved: number;
  raw_cost: number;
  charged: number;
  profit: number;
  balance_left: number;
  wallet_balance: number;
}

interface ModeStat {
  mode: string;
  display_name: string;
  model_id: string;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  raw_cost: number;
  charged: number;
  profit: number;
}

interface DayStat {
  day: string;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  raw_cost: number;
  charged: number;
  profit: number;
}

interface RecentCall {
  id: number;
  username: string;
  mode: string;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  raw_cost: number;
  charged: number;
  profit: number;
  timestamp: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt$(n: number | null | undefined, decimals = 4): string {
  if (n == null) return '—';
  if (Math.abs(n) < 0.0001 && n !== 0) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(decimals)}`;
}

function fmtK(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function margin(profit: number, charged: number): string {
  if (!charged) return '—';
  return `${((profit / charged) * 100).toFixed(1)}%`;
}

const MODES = [
  { value: '', label: 'All Modes' },
  { value: 'free', label: '⚡ Free' },
  { value: 'fast', label: '🚀 Fast' },
  { value: 'pro',  label: '🧠 Pro' },
];

// ── SummaryCard ───────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: '16px 12px' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AdminUsageStats() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [perUser, setPerUser] = useState<UserStat[]>([]);
  const [perMode, setPerMode] = useState<ModeStat[]>([]);
  const [recent, setRecent] = useState<RecentCall[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filterMode, setFilterMode] = useState('');
  const [perDay, setPerDay] = useState<DayStat[]>([]);
  const [tab, setTab] = useState<'user' | 'mode' | 'recent' | 'daily'>('user');
  const [loading, setLoading] = useState(false);

  useEffect(() => { load(); }, [from, to, filterMode]);

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (filterMode) params.set('mode', filterMode);
    const res = await fetch(`/admin/api/usage-stats?${params}`, { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      setSummary(data.summary);
      setPerUser(data.perUser || []);
      setPerMode(data.perMode || []);
      setRecent(data.recent || []);
      setPerDay(data.perDay || []);
    }
    setLoading(false);
  }

  const totalTokens = summary
    ? summary.total_input_tokens + summary.total_output_tokens
    : 0;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>📊 Reports</h1>
        <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {/* ── Filters ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ width: 'auto' }} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={{ width: 'auto' }} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Mode</label>
          <select value={filterMode} onChange={e => setFilterMode(e.target.value)} style={{ width: 'auto' }}>
            {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        {(from || to || filterMode) && (
          <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-end' }}
            onClick={() => { setFrom(''); setTo(''); setFilterMode(''); }}>
            Clear Filters
          </button>
        )}
      </div>

      {/* ── Summary Cards ───────────────────────────────────────────────────── */}
      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 28 }}>
          <SummaryCard
            label="Total Tokens"
            value={fmtK(totalTokens)}
            sub={`${fmtK(summary.total_input_tokens)} in · ${fmtK(summary.total_output_tokens)} out`}
          />
          <SummaryCard
            label="Calls / Sessions"
            value={String(summary.total_sessions)}
            sub={`${summary.total_users} user${summary.total_users !== 1 ? 's' : ''}`}
          />
          <SummaryCard
            label="Provider Cost"
            value={fmt$(summary.total_raw_cost, 4)}
            sub="what AI charged us"
            color="var(--text-secondary)"
          />
          <SummaryCard
            label="Billed to Users"
            value={fmt$(summary.total_charged, 4)}
            sub="charged_cost total"
            color="var(--accent)"
          />
          <SummaryCard
            label="Profit"
            value={fmt$(summary.total_profit, 4)}
            sub={`Margin: ${margin(summary.total_profit, summary.total_charged)}`}
            color={summary.total_profit >= 0 ? 'var(--success, #22c55e)' : 'var(--error, #ef4444)'}
          />
          {(summary.total_cache_write + summary.total_cache_read) > 0 && (
            <SummaryCard
              label="Cache Tokens (Session)"
              value={fmtK(summary.total_cache_write + summary.total_cache_read)}
              sub={`${fmtK(summary.total_cache_write)} write · ${fmtK(summary.total_cache_read)} read`}
            />
          )}
          {summary.total_cached_saved > 0 && (
            <SummaryCard
              label="💾 Tokens Saved via Cache"
              value={fmtK(summary.total_cached_saved)}
              sub="Cumulative — resettable per user"
              color="var(--success, #22c55e)"
            />
          )}
        </div>
      )}

      {/* ── Tabs ────────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginBottom: 0 }}>
        {(['user', 'mode', 'recent', 'daily'] as const).map((key) => {
          const labels: Record<string, string> = { user: '👤 By User', mode: '🎛️ By Mode', recent: '🕐 Recent Calls', daily: '📅 Daily' };
          return (
            <button key={key} onClick={() => setTab(key)} style={{
              padding: '8px 18px',
              fontWeight: tab === key ? 600 : 400,
              fontSize: 13,
              background: 'none',
              border: 'none',
              borderBottom: `2px solid ${tab === key ? 'var(--accent)' : 'transparent'}`,
              color: tab === key ? 'var(--text-primary)' : 'var(--text-muted)',
              cursor: 'pointer',
              marginBottom: -1,
            }}>
              {labels[key]}
            </button>
          );
        })}
      </div>

      {/* ── By User ─────────────────────────────────────────────────────────── */}
      {tab === 'user' && (
        <div className="card table-responsive" style={{ padding: 0, overflow: 'auto', borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
          <table style={{ fontSize: 13, minWidth: 800 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>User</th>
                <th>Calls</th>
                <th>💾 Cached</th>
                <th>Input Tokens</th>
                <th>Output Tokens</th>
                <th>Provider Cost</th>
                <th>Billed</th>
                <th style={{ color: 'var(--success, #22c55e)' }}>Profit</th>
                <th>Margin</th>
                <th>Balance Left</th>
                <th>Bot Wallet</th>
              </tr>
            </thead>
            <tbody>
              {perUser.map(u => (
                <tr key={u.user_id}>
                  <td>
                    <span style={{ fontWeight: 500 }}>{u.username}</span>
                    {u.display_name && (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>({u.display_name})</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'center' }}>{u.sessions}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <span style={{ color: u.cached_tokens_saved > 0 ? 'var(--success, #22c55e)' : 'var(--text-muted)' }}>
                      {fmtK(u.cached_tokens_saved)}
                    </span>
                    {u.cached_tokens_saved > 0 && (
                      <span
                        title="Reset cached tokens counter"
                        style={{ cursor: 'pointer', marginLeft: 6, fontSize: 14, opacity: 0.6 }}
                        onClick={async () => {
                          if (!confirm(`Reset cached tokens for ${u.username}?`)) return;
                          await fetch(`/admin/api/cached-tokens/${u.user_id}/reset`, { method: 'POST', credentials: 'include' });
                          load();
                        }}
                      >🔄</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmtK(u.input_tokens)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtK(u.output_tokens)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{fmt$(u.raw_cost)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt$(u.charged)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: u.profit >= 0 ? 'var(--success, #22c55e)' : 'var(--error, #ef4444)' }}>
                    {fmt$(u.profit)}
                  </td>
                  <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-muted)' }}>{margin(u.profit, u.charged)}</td>
                  <td style={{ textAlign: 'right', fontSize: 12 }}>{fmt$(u.balance_left, 2)}</td>
                  <td style={{ textAlign: 'right', fontSize: 12 }}>{fmt$(u.wallet_balance, 2)}</td>
                </tr>
              ))}
            </tbody>
            {perUser.length > 1 && summary && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 700 }}>
                  <td>Total</td>
                  <td style={{ textAlign: 'center' }}>{summary.total_sessions}</td>
                  <td style={{ textAlign: 'right' }}>{fmtK(summary.total_cached_saved)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtK(summary.total_input_tokens)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtK(summary.total_output_tokens)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{fmt$(summary.total_raw_cost)}</td>
                  <td style={{ textAlign: 'right' }}>{fmt$(summary.total_charged)}</td>
                  <td style={{ textAlign: 'right', color: summary.total_profit >= 0 ? 'var(--success, #22c55e)' : 'var(--error, #ef4444)' }}>
                    {fmt$(summary.total_profit)}
                  </td>
                  <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-muted)' }}>
                    {margin(summary.total_profit, summary.total_charged)}
                  </td>
                  <td /><td />
                </tr>
              </tfoot>
            )}
          </table>
          {perUser.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              No usage data for the selected period.
            </div>
          )}
        </div>
      )}

      {/* ── By Mode ─────────────────────────────────────────────────────────── */}
      {tab === 'mode' && (
        <div className="card table-responsive" style={{ padding: 0, overflow: 'auto', borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
          <table style={{ fontSize: 13, minWidth: 800 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Mode</th>
                <th style={{ textAlign: 'left' }}>Model</th>
                <th>Calls</th>
                <th>Input Tokens</th>
                <th>Output Tokens</th>
                <th>Cache Tokens</th>
                <th>Provider Cost</th>
                <th>Billed</th>
                <th style={{ color: 'var(--success, #22c55e)' }}>Profit</th>
                <th>Margin</th>
              </tr>
            </thead>
            <tbody>
              {perMode.map(m => (
                <tr key={m.mode}>
                  <td style={{ fontWeight: 600 }}>{m.display_name || m.mode}</td>
                  <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-secondary)' }}>
                    {m.model_id || '—'}
                  </td>
                  <td style={{ textAlign: 'center' }}>{m.sessions}</td>
                  <td style={{ textAlign: 'right' }}>{fmtK(m.input_tokens)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtK(m.output_tokens)}</td>
                  <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-muted)' }}>
                    {fmtK(m.cache_write_tokens + m.cache_read_tokens)}
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{fmt$(m.raw_cost)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt$(m.charged)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: m.profit >= 0 ? 'var(--success, #22c55e)' : 'var(--error, #ef4444)' }}>
                    {fmt$(m.profit)}
                  </td>
                  <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-muted)' }}>{margin(m.profit, m.charged)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {perMode.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              No usage data for the selected period.
            </div>
          )}
        </div>
      )}

      {/* ── Recent Calls ────────────────────────────────────────────────────── */}
      {tab === 'recent' && (
        <div className="card table-responsive" style={{ padding: 0, overflow: 'auto', borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
          <table style={{ fontSize: 12, minWidth: 700 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Time</th>
                <th style={{ textAlign: 'left' }}>User</th>
                <th>Mode</th>
                <th>In Tokens</th>
                <th>Out Tokens</th>
                <th>Provider Cost</th>
                <th>Billed</th>
                <th style={{ color: 'var(--success, #22c55e)' }}>Profit</th>
              </tr>
            </thead>
            <tbody>
              {recent.map(r => (
                <tr key={r.id}>
                  <td style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{r.timestamp.slice(0, 16)}</td>
                  <td style={{ fontWeight: 500 }}>{r.username}</td>
                  <td style={{ textAlign: 'center' }}>{r.mode}</td>
                  <td style={{ textAlign: 'right' }}>{fmtK(r.input_tokens)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtK(r.output_tokens)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{fmt$(r.raw_cost, 6)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt$(r.charged, 6)}</td>
                  <td style={{ textAlign: 'right', color: r.profit >= 0 ? 'var(--success, #22c55e)' : 'var(--error, #ef4444)' }}>
                    {fmt$(r.profit, 6)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {recent.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              No usage data for the selected period.
            </div>
          )}
        </div>
      )}

      {/* ── Daily Trend ─────────────────────────────────────────────────────── */}
      {tab === 'daily' && (
        <div className="card table-responsive" style={{ padding: 0, overflow: 'auto', borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
          <table style={{ fontSize: 13, minWidth: 600 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Date</th>
                <th>Calls</th>
                <th>Input Tokens</th>
                <th>Output Tokens</th>
                <th>Provider Cost</th>
                <th>Billed</th>
                <th style={{ color: 'var(--success, #22c55e)' }}>Profit</th>
                <th>Margin</th>
              </tr>
            </thead>
            <tbody>
              {perDay.map(d => (
                <tr key={d.day}>
                  <td style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{d.day}</td>
                  <td style={{ textAlign: 'center' }}>{d.sessions}</td>
                  <td style={{ textAlign: 'right' }}>{fmtK(d.input_tokens)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtK(d.output_tokens)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{fmt$(d.raw_cost)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt$(d.charged)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: d.profit >= 0 ? 'var(--success, #22c55e)' : 'var(--error, #ef4444)' }}>
                    {fmt$(d.profit)}
                  </td>
                  <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-muted)' }}>{margin(d.profit, d.charged)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {perDay.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              No daily data for the selected period.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

