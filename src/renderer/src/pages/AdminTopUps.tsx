import { useState, useEffect } from 'react';

interface TopUpRequest {
  id: number;
  user_id: number;
  username: string | null;
  amount: number;
  note: string;
  status: 'pending' | 'approved' | 'rejected';
  admin_notes: string;
  created_at: string;
  resolved_at: string | null;
}

export default function AdminTopUps() {
  const [requests, setRequests] = useState<TopUpRequest[]>([]);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actingOn, setActingOn] = useState<number | null>(null);
  const [adminNotes, setAdminNotes] = useState<Record<number, string>>({});

  useEffect(() => { load(); }, [statusFilter]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/admin/api/topup-requests?status=${statusFilter}`, { credentials: 'include' });
      if (res.ok) setRequests(await res.json());
      else setError(`Failed to load (${res.status})`);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }

  async function act(id: number, action: 'approve' | 'reject') {
    setActingOn(id);
    setError('');
    try {
      const res = await fetch(`/admin/api/topup-requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action, adminNotes: adminNotes[id] || '' }),
      });
      if (res.ok) {
        await load();
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.error || `Failed (${res.status})`);
      }
    } catch (e) { setError(String(e)); }
    finally { setActingOn(null); }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <h2 style={{ margin: 0 }}>Top-Up Requests</h2>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['pending', 'approved', 'rejected', 'all'] as const).map(s => (
            <button
              key={s}
              className={`btn btn-sm ${statusFilter === s ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setStatusFilter(s)}
            >{s}</button>
          ))}
        </div>
      </div>

      {error && <div style={{ padding: 10, marginBottom: 12, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: 'var(--error)' }}>{error}</div>}

      {loading && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}

      {!loading && requests.length === 0 && (
        <div style={{ color: 'var(--text-muted)', padding: 24, textAlign: 'center' }}>No {statusFilter} requests.</div>
      )}

      {requests.map(r => (
        <div key={r.id} style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 14,
          marginBottom: 10,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div>
              <strong>{r.username || `user#${r.user_id}`}</strong>
              <span style={{ marginLeft: 10, fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>${r.amount.toFixed(2)}</span>
              <span style={{
                marginLeft: 10, fontSize: 11, padding: '2px 8px', borderRadius: 999,
                background: r.status === 'pending' ? 'rgba(234,179,8,0.15)' : r.status === 'approved' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                color: r.status === 'pending' ? '#eab308' : r.status === 'approved' ? '#22c55e' : '#ef4444',
              }}>{r.status}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.created_at}</div>
          </div>

          {r.note && <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>📝 {r.note}</div>}
          {r.admin_notes && <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: 8 }}>Admin: {r.admin_notes}</div>}

          {r.status === 'pending' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <input
                type="text"
                placeholder="Admin notes (optional)"
                value={adminNotes[r.id] || ''}
                onChange={e => setAdminNotes(prev => ({ ...prev, [r.id]: e.target.value }))}
                className="input"
                style={{ flex: 1 }}
                disabled={actingOn === r.id}
              />
              <button
                className="btn btn-sm btn-primary"
                disabled={actingOn === r.id}
                onClick={() => act(r.id, 'approve')}
              >Approve</button>
              <button
                className="btn btn-sm btn-secondary"
                disabled={actingOn === r.id}
                onClick={() => act(r.id, 'reject')}
              >Reject</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
