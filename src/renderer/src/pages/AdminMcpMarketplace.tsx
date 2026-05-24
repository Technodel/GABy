import { useState, useEffect } from 'react';
import { Package, Plus, Trash2, Power } from 'lucide-react';

interface McpEntry {
  id: number;
  name: string;
  display_name: string;
  description: string;
  author: string;
  transport: string;
  category: string;
  install_count: number;
  rating: number;
  is_official: boolean;
}

interface InstalledMcp {
  id: number;
  name: string;
  display_name: string;
  transport: string;
  is_active: boolean;
  installed_at: string;
}

export default function AdminMcpMarketplace() {
  const [marketplace, setMarketplace] = useState<McpEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledMcp[]>([]);
  const [tab, setTab] = useState<'marketplace' | 'installed'>('installed');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, [tab]);

  async function loadData() {
    setLoading(true);
    try {
      if (tab === 'installed') {
        const res = await fetch('/admin/api/mcp/installed', { credentials: 'include' });
        if (res.ok) setInstalled(await res.json());
      } else {
        const res = await fetch('/admin/api/mcp/marketplace', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setMarketplace(data.entries || []);
        }
      }
    } finally {
      setLoading(false);
    }
  }

  async function install(id: number) {
    if (!confirm('Install this MCP server?')) return;
    await fetch(`/admin/api/mcp/marketplace/${id}/install`, { method: 'POST', credentials: 'include' });
    alert('Installed successfully! You can now use its tools in chat.');
  }

  async function uninstall(id: number) {
    if (!confirm('Uninstall this MCP server?')) return;
    await fetch(`/admin/api/mcp/installed/${id}`, { method: 'DELETE', credentials: 'include' });
    loadData();
  }

  async function toggleActive(id: number, currentActive: boolean) {
    await fetch(`/admin/api/mcp/installed/${id}/toggle`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !currentActive }),
    });
    loadData();
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>🏪 MCP Marketplace</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className={`btn btn-sm ${tab === 'installed' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('installed')}>Installed</button>
          <button className={`btn btn-sm ${tab === 'marketplace' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('marketplace')}>Browse Marketplace</button>
        </div>
      </div>

      <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 'var(--radius-sm)', background: 'rgba(108,99,255,0.06)', border: '1px solid var(--accent)', fontSize: 13, color: 'var(--text-secondary)' }}>
        Model Context Protocol (MCP) servers add native capabilities (databases, devops, search) to SUNy without touching the core codebase.
      </div>

      {loading ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>
      ) : tab === 'marketplace' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {marketplace.map(m => (
            <div key={m.id} className="card" style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{m.display_name}</h3>
                {m.is_official && <span className="badge badge-green">Official</span>}
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', flex: 1 }}>{m.description}</p>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{m.author} &bull; {m.category}</div>
                <button className="btn btn-sm btn-primary" onClick={() => install(m.id)}>
                  <Plus size={14} /> Install
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card table-responsive" style={{ padding: 0 }}>
          {installed.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>No MCP servers installed. Click Browse Marketplace to add some.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Transport</th>
                  <th>Status</th>
                  <th>Installed At</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {installed.map(i => (
                  <tr key={i.id}>
                    <td style={{ fontWeight: 500 }}>{i.display_name}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{i.transport}</td>
                    <td>
                      <span className={`badge ${i.is_active ? 'badge-green' : 'badge-amber'}`}>
                        {i.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{new Date(i.installed_at).toLocaleDateString()}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-sm btn-secondary" onClick={() => toggleActive(i.id, i.is_active)} title="Toggle Active">
                          <Power size={14} />
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => uninstall(i.id)}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
