import { useState, useEffect } from 'react';
import { Plus, Edit2, Trash2, X } from 'lucide-react';

interface User {
  id: number;
  username: string;
  balance: number;
  wallet_balance: number;
  is_active: number;
  max_tokens_per_session: number | null;
  created_at: string;
  last_visit: string | null;
}

export default function AdminUsers() {
  const [users, setUsers] = useState<User[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);

  // Create form state
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newBalance, setNewBalance] = useState('0');
  const [newMaxTokens, setNewMaxTokens] = useState('');

  // Edit form state
  const [editBalanceDelta, setEditBalanceDelta] = useState('');
  const [editWalletSet, setEditWalletSet] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editMaxTokens, setEditMaxTokens] = useState('');

  const [error, setError] = useState('');

  useEffect(() => { loadUsers(); }, []);

  async function loadUsers() {
    const res = await fetch('/admin/api/users', { credentials: 'include' });
    if (res.ok) setUsers(await res.json());
  }

  async function createUser() {
    setError('');
    const res = await fetch('/admin/api/users', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: newUsername,
        password: newPassword,
        balance: parseFloat(newBalance) || 0,
        max_tokens_per_session: newMaxTokens ? parseInt(newMaxTokens, 10) : null,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      setShowCreate(false);
      setNewUsername(''); setNewPassword(''); setNewBalance('0'); setNewMaxTokens('');
      loadUsers();
    } else {
      const detailMsg = data.details
        ? Object.entries(data.details.fieldErrors || {})
            .flatMap(([f, msgs]) => (msgs as string[]).map(m => `${f}: ${m}`))
            .join('; ')
        : '';
    setError((data.error || 'Failed to create user') + (detailMsg ? ` — ${detailMsg}` : ''));
    }
  }

  async function updateUser() {
    if (!editUser) return;
    setError('');
    const body: Record<string, unknown> = {};
    if (editBalanceDelta) body.balance_delta = parseFloat(editBalanceDelta);
    if (editWalletSet !== '') body.wallet_balance_set = parseFloat(editWalletSet);
    if (editPassword) body.password = editPassword;
    if (editMaxTokens !== '') body.max_tokens_per_session = editMaxTokens ? parseInt(editMaxTokens, 10) : null;
    const res = await fetch(`/admin/api/users/${editUser.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) {
      setEditUser(null); setEditBalanceDelta(''); setEditWalletSet(''); setEditPassword(''); setEditMaxTokens('');
      loadUsers();
    } else {
      setError(data.error || 'Failed to update user');
    }
  }

  async function toggleActive(user: User) {
    await fetch(`/admin/api/users/${user.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: user.is_active === 0 }),
    });
    loadUsers();
  }

  async function deleteUser(id: number) {
    if (!confirm('Deactivate this user?')) return;
    await fetch(`/admin/api/users/${id}`, { method: 'DELETE', credentials: 'include' });
    loadUsers();
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>👥 Users</h1>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={14} /> Add User
        </button>
      </div>

      <div className="card table-responsive" style={{ padding: 0, overflow: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Credits</th>
              <th>Wallet</th>
              <th>Status</th>
              <th>Max Tokens</th>
              <th>Last Visit</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id}>
                <td style={{ fontWeight: 500 }}>{u.username}</td>
                <td>${u.balance.toFixed(2)}</td>
                <td style={{ color: u.wallet_balance > 0 ? 'var(--success,#22c55e)' : 'var(--text-muted)' }}>
                  ${(u.wallet_balance ?? 0).toFixed(2)}
                </td>
                <td>
                  <span className={`badge ${u.is_active ? 'badge-green' : 'badge-red'}`}>
                    {u.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td style={{ color: 'var(--text-muted)' }}>
                  {u.max_tokens_per_session ? u.max_tokens_per_session.toLocaleString() : 'Unlimited'}
                </td>
                <td style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>
                  {u.last_visit ? new Date(u.last_visit).toLocaleDateString() + ' ' + new Date(u.last_visit).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'Never'}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => {
                      setEditUser(u);
                      setEditBalanceDelta('');
                      setEditWalletSet(u.wallet_balance != null ? String(u.wallet_balance.toFixed(2)) : '0');
                      setEditPassword('');
                      setEditMaxTokens(u.max_tokens_per_session ? String(u.max_tokens_per_session) : '');
                    }}>
                      <Edit2 size={12} />
                    </button>
                    <button className="btn btn-sm btn-secondary" onClick={() => toggleActive(u)}>
                      {u.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create User Modal */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 className="modal-title" style={{ margin: 0 }}>Add User</h3>
              <button className="btn btn-icon btn-secondary btn-sm" onClick={() => setShowCreate(false)}><X size={14} /></button>
            </div>
            {error && <div style={{ color: 'var(--error)', fontSize: 13, marginBottom: 12 }}>{error}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Username</label>
                <input value={newUsername} onChange={e => setNewUsername(e.target.value)} placeholder="username" />
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Password</label>
                <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="password (min 6 characters)" minLength={6} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Initial Balance ($)</label>
                <input type="number" value={newBalance} onChange={e => setNewBalance(e.target.value)} placeholder="0" min="0" step="0.01" />
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Max Tokens per Session (blank = unlimited)</label>
                <input type="number" value={newMaxTokens} onChange={e => setNewMaxTokens(e.target.value)} placeholder="Unlimited" min="0" />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={createUser}>Create User</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {editUser && (
        <div className="modal-overlay" onClick={() => setEditUser(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 className="modal-title" style={{ margin: 0 }}>Edit: {editUser.username}</h3>
              <button className="btn btn-icon btn-secondary btn-sm" onClick={() => setEditUser(null)}><X size={14} /></button>
            </div>            {error && <div style={{ color: 'var(--error)', fontSize: 13, marginBottom: 12 }}>{error}</div>}            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                  Balance Adjustment (+ to add, − to subtract)
                </label>
                <input type="number" value={editBalanceDelta} onChange={e => setEditBalanceDelta(e.target.value)}
                  placeholder="e.g. +10 or -5" step="0.01" />
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  Current balance: ${editUser.balance.toFixed(2)}
                </div>
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                  Set Bot Wallet ($)
                </label>
                <input type="number" value={editWalletSet} onChange={e => setEditWalletSet(e.target.value)}
                  placeholder="0.00" step="0.01" min="0" />
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  Current wallet: ${(editUser.wallet_balance ?? 0).toFixed(2)}
                </div>
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>New Password (blank = no change)</label>
                <input type="password" value={editPassword} onChange={e => setEditPassword(e.target.value)} placeholder="leave blank to keep current" />
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Max Tokens per Session (blank = unlimited)</label>
                <input type="number" value={editMaxTokens} onChange={e => setEditMaxTokens(e.target.value)} placeholder="Unlimited" min="0" />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setEditUser(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={updateUser}>Save Changes</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
