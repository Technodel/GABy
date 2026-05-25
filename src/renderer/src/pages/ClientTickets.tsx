import { useState, useEffect } from 'react';
import { Trash2, Plus, ExternalLink, RefreshCw, MessageCircle, Archive, CheckCircle, X } from 'lucide-react';

interface Ticket {
  id: number;
  uid: string;
  project_name: string;
  company_name: string;
  goal: string;
  messages: { role: string; content: string; timestamp: string }[];
  status: string;
  summary: string;
  suggestions: string;
  created_at: string;
  closed_at: string | null;
}

export default function ClientTickets({ onBack, onOpenSettings }: { onBack: () => void; onOpenSettings: () => void }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newGoal, setNewGoal] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectId, setNewProjectId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [createdLink, setCreatedLink] = useState('');
  const [error, setError] = useState('');
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [projects, setProjects] = useState<{ id: number; name: string }[]>([]);

  useEffect(() => {
    loadTickets();
    // Load projects for the form
    fetch('/api/projects', { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then(data => setProjects(Array.isArray(data) ? data : (data.projects || [])))
      .catch(() => {});
  }, []);

  async function loadTickets() {
    setLoading(true);
    try {
      const res = await fetch('/api/client-tickets', { credentials: 'include' });
      const data = await res.json();
      if (data.tickets) setTickets(data.tickets);
    } catch {}
    setLoading(false);
  }

  async function createTicket() {
    if (!newGoal.trim()) return;
    const companyName = localStorage.getItem('suny_company_name') || '';
    if (!companyName.trim()) {
      setError('Set your company/personal name in Settings first!');
      return;
    }

    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/client-tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          project_id: newProjectId,
          project_name: newProjectName || undefined,
          goal: newGoal.trim(),
          company_name: companyName.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok && data.ticket) {
        setCreatedLink(data.link);
        setTickets(prev => [data.ticket, ...prev]);
      } else {
        setError(data.error || 'Failed to create ticket');
      }
    } catch {
      setError('Failed to connect. Try again.');
    }
    setCreating(false);
  }

  async function closeTicket(ticket: Ticket) {
    try {
      const res = await fetch(`/api/client-tickets/${ticket.id}/close`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (data.ticket) {
        setTickets(prev => prev.map(t => t.id === ticket.id ? data.ticket : t));
        if (selectedTicket?.id === ticket.id) setSelectedTicket(data.ticket);
      }
    } catch {}
  }

  async function reopenTicket(ticket: Ticket) {
    try {
      const res = await fetch(`/api/client-tickets/${ticket.id}/reopen`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (data.ticket) {
        setTickets(prev => prev.map(t => t.id === ticket.id ? data.ticket : t));
        if (selectedTicket?.id === ticket.id) setSelectedTicket(data.ticket);
      }
    } catch {}
  }

  async function deleteTicket(ticket: Ticket) {
    if (!confirm('Delete this ticket permanently?')) return;
    try {
      await fetch(`/api/client-tickets/${ticket.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      setTickets(prev => prev.filter(t => t.id !== ticket.id));
      if (selectedTicket?.id === ticket.id) setSelectedTicket(null);
    } catch {}
  }

  function copyLink(link: string) {
    navigator.clipboard.writeText(link);
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', padding: 24 }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <button className="btn btn-secondary btn-sm" onClick={onBack}>← Back</button>
          <h1 style={{ fontSize: 20, fontWeight: 600, flex: 1 }}>🔗 Client Tickets</h1>
          <button className="btn btn-primary btn-sm" onClick={() => { setShowNewForm(true); setCreatedLink(''); setNewGoal(''); }} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Plus size={14} /> New Ticket
          </button>
          <button className="btn btn-secondary btn-sm" onClick={loadTickets} title="Refresh">
            <RefreshCw size={14} />
          </button>
        </div>

        {error && (
          <div style={{ padding: '10px 14px', background: 'rgba(255,60,60,0.1)', border: '1px solid rgba(255,60,60,0.3)', borderRadius: 8, marginBottom: 16, fontSize: 13, color: 'var(--error)' }}>
            <div>{error}</div>
            {error === 'Set your company/personal name in Settings first!' && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={onOpenSettings}
                style={{ marginTop: 10 }}
              >
                Open Settings
              </button>
            )}
          </div>
        )}

        {/* New ticket form */}
        {showNewForm && (
          <div className="card" style={{ marginBottom: 20, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ fontWeight: 600, fontSize: 15 }}>Create New Client Ticket</h3>
              <button onClick={() => setShowNewForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
                <X size={16} />
              </button>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Project (optional)</label>
              <select
                value={newProjectId ?? ''}
                onChange={e => {
                  const val = e.target.value;
                  if (val === '') { setNewProjectId(null); setNewProjectName(''); }
                  else {
                    const pid = parseInt(val);
                    setNewProjectId(pid);
                    const p = projects.find(x => x.id === pid);
                    setNewProjectName(p?.name || '');
                  }
                }}
                style={{ width: '100%' }}
              >
                <option value="">-- No project --</option>
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                What do you need from your client? *
              </label>
              <textarea
                value={newGoal}
                onChange={e => setNewGoal(e.target.value)}
                placeholder="e.g. I need the client to provide their logo files, brand colors, and preferred layout for the homepage redesign..."
                rows={3}
                style={{ width: '100%', resize: 'vertical' }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" onClick={createTicket} disabled={creating || !newGoal.trim()} style={{ flex: 1 }}>
                {creating ? 'Generating...' : '✨ Generate Ticket Link'}
              </button>
            </div>

            {createdLink && (
              <div style={{ marginTop: 12, padding: 10, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--success)', marginBottom: 4 }}>✅ Ticket created!</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="text" readOnly value={createdLink} style={{ flex: 1, fontSize: 12 }} onClick={e => (e.target as HTMLInputElement).select()} />
                  <button className="btn btn-primary btn-sm" onClick={() => copyLink(createdLink)}>Copy Link</button>
                  <a href={createdLink} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm" style={{ display: 'flex', alignItems: 'center', gap: 3, textDecoration: 'none' }}>
                    <ExternalLink size={12} /> Open
                  </a>
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Share this link with your client. SUNy will talk to them directly!</p>
              </div>
            )}
          </div>
        )}

        {/* Tickets list */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Loading tickets...</div>
        ) : tickets.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🔗</div>
            <p style={{ fontSize: 15, marginBottom: 8 }}>No tickets yet</p>
            <p style={{ fontSize: 13 }}>Create a ticket to get started — SUNy will talk to your client directly!</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {tickets.map(ticket => (
              <div
                key={ticket.id}
                className="card"
                style={{
                  padding: '12px 16px',
                  cursor: 'pointer',
                  borderLeft: `3px solid ${ticket.status === 'open' ? 'var(--accent)' : 'var(--text-muted)'}`,
                  opacity: selectedTicket?.id === ticket.id ? 1 : 0.85,
                }}
                onClick={() => setSelectedTicket(selectedTicket?.id === ticket.id ? null : ticket)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                      <span style={{
                        fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999,
                        background: ticket.status === 'open' ? 'rgba(16,185,129,0.12)' : 'rgba(100,100,100,0.12)',
                        color: ticket.status === 'open' ? 'var(--success)' : 'var(--text-muted)',
                      }}>
                        {ticket.status === 'open' ? '● Open' : '✓ Closed'}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {new Date(ticket.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {ticket.goal}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {ticket.company_name} {ticket.project_name ? `· ${ticket.project_name}` : ''} · {ticket.messages.length} messages
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginLeft: 8 }}>
                    {ticket.status === 'open' ? (
                      <button
                        className="btn btn-icon btn-sm"
                        onClick={e => { e.stopPropagation(); closeTicket(ticket); }}
                        style={{ background: 'none', border: 'none', color: 'var(--success)', cursor: 'pointer', padding: 2 }}
                        title="Close ticket"
                      >
                        <CheckCircle size={14} />
                      </button>
                    ) : (
                      <button
                        className="btn btn-icon btn-sm"
                        onClick={e => { e.stopPropagation(); reopenTicket(ticket); }}
                        style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 2 }}
                        title="Reopen ticket"
                      >
                        <RefreshCw size={14} />
                      </button>
                    )}
                    <button
                      className="btn btn-icon btn-sm"
                      onClick={e => { e.stopPropagation(); deleteTicket(ticket); }}
                      style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}
                      title="Delete ticket"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {/* Expanded ticket detail */}
                {selectedTicket?.id === ticket.id && (
                  <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                    {/* Conversation */}
                    <div style={{ maxHeight: 300, overflowY: 'auto', marginBottom: 12 }}>
                      {ticket.messages.map((msg, idx) => (
                        <div key={idx} style={{
                          marginBottom: 8,
                          padding: '8px 12px',
                          borderRadius: 8,
                          background: msg.role === 'user' ? 'rgba(108,99,255,0.06)' : 'var(--surface)',
                          border: '1px solid var(--border)',
                          fontSize: 13,
                          lineHeight: 1.5,
                        }}>
                          <div style={{ fontSize: 10, fontWeight: 600, color: msg.role === 'user' ? 'var(--accent)' : 'var(--text-muted)', marginBottom: 2 }}>
                            {msg.role === 'user' ? 'Client' : 'SUNy'}
                          </div>
                          <div style={{ color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                        </div>
                      ))}
                    </div>

                    {/* Summary (if closed) */}
                    {ticket.status === 'closed' && ticket.summary && (
                      <div style={{ padding: 10, background: 'rgba(16,185,129,0.06)', borderRadius: 8, border: '1px solid rgba(16,185,129,0.2)', marginBottom: 8 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--success)', marginBottom: 4 }}>📋 Summary</div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{ticket.summary}</div>
                        {ticket.suggestions && (
                          <>
                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', marginTop: 8, marginBottom: 4 }}>💡 Suggestions</div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{ticket.suggestions}</div>
                          </>
                        )}
                      </div>
                    )}

                    {/* Link */}
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12 }}>
                      <input
                        type="text"
                        readOnly
                        value={`${window.location.origin}/client-link/${ticket.uid}`}
                        style={{ flex: 1, fontSize: 11 }}
                        onClick={e => (e.target as HTMLInputElement).select()}
                      />
                      <button className="btn btn-primary btn-sm" onClick={() => copyLink(`${window.location.origin}/client-link/${ticket.uid}`)}>
                        Copy Link
                      </button>
                      <a href={`/client-link/${ticket.uid}`} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm" style={{ display: 'flex', alignItems: 'center', gap: 3, textDecoration: 'none' }}>
                        <ExternalLink size={12} /> Open
                      </a>
                    </div>
                    
                    {/* Advanced Visual Portal Snippet */}
                    <div style={{ padding: 12, background: 'rgba(255, 158, 0, 0.06)', borderRadius: 8, border: '1px solid rgba(255, 158, 0, 0.3)' }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', marginBottom: 6 }}>
                        🔭 Advanced Visual Portal <span style={{ fontSize: 10, padding: '2px 6px', background: 'var(--accent)', color: '#fff', borderRadius: 999, marginLeft: 4 }}>PRO</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.5 }}>
                        Instead of sending the link, paste this snippet into the <code style={{color: 'var(--text-primary)'}}>&lt;head&gt;</code> of your staging website. Your client will see a floating "SUNy" button that lets them click visually on any element to request changes directly to your codebase.
                      </div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          type="text"
                          readOnly
                          value={`<script src="${window.location.origin}/api/portal.js?ticket_uid=${ticket.uid}"></script>`}
                          style={{ flex: 1, fontSize: 11, fontFamily: 'monospace', background: 'var(--surface)' }}
                          onClick={e => (e.target as HTMLInputElement).select()}
                        />
                        <button className="btn btn-secondary btn-sm" onClick={() => copyLink(`<script src="${window.location.origin}/api/portal.js?ticket_uid=${ticket.uid}"></script>`)}>
                          Copy Snippet
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
