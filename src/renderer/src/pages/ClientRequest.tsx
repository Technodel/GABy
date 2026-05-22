import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Send, CheckCircle } from 'lucide-react';

interface TicketInfo {
  uid: string;
  company_name: string;
  project_name: string;
  goal: string;
  messages: { role: string; content: string; timestamp: string }[];
  status: string;
  created_at: string;
}

export default function ClientRequest() {
  const { uid } = useParams<{ uid: string }>();
  const [ticket, setTicket] = useState<TicketInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [aiThinking, setAiThinking] = useState(false);
  const [summary, setSummary] = useState('');
  const [suggestions, setSuggestions] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!uid) return;
    fetch(`/api/client-ticket/${uid}`)
      .then(r => r.ok ? r.json() : Promise.reject('Not found'))
      .then(data => {
        if (data.ticket) {
          setTicket(data.ticket);
          setMessages(data.ticket.messages || []);
        } else {
          setError('This ticket is no longer active.');
        }
      })
      .catch(() => setError('This ticket is no longer active.'))
      .finally(() => setLoading(false));
  }, [uid]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, aiThinking]);

  async function sendMessage() {
    if (!input.trim() || sending || !uid) return;
    const msg = input.trim();
    setInput('');
    setSending(true);
    setAiThinking(true);

    // Optimistically add user message
    setMessages(prev => [...prev, { role: 'user', content: msg }]);

    try {
      const res = await fetch(`/api/client-ticket/${uid}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
      const data = await res.json();
      if (res.ok && data.message) {
        setMessages(prev => [...prev, { role: 'assistant', content: data.message }]);
      }
    } catch {}
    setSending(false);
    setAiThinking(false);
  }

  async function handleConfirm() {
    if (!uid || confirmed) return;
    setAiThinking(true);
    try {
      const res = await fetch(`/api/client-ticket/${uid}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (res.ok) {
        setConfirmed(true);
        setSummary(data.summary || '');
        setSuggestions(data.suggestions || '');
        if (data.message) {
          setMessages(prev => [...prev, { role: 'assistant', content: data.message }]);
        }
      }
    } catch {}
    setAiThinking(false);
  }

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="thinking-indicator">
          <div className="dot" /><div className="dot" /><div className="dot" />
        </div>
      </div>
    );
  }

  if (error || !ticket) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <div className="card" style={{ maxWidth: 480, textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🔗</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>Link Not Found</h1>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.6 }}>
            {error || 'This ticket link does not exist or has expired.'}
          </p>
          <Link to="/" className="btn btn-primary" style={{ textDecoration: 'none', display: 'inline-flex' }}>
            Go to SUNy
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg)',
      display: 'flex',
      flexDirection: 'column',
      maxWidth: 680,
      margin: '0 auto',
      padding: '0 16px',
    }}>
      {/* Header */}
      <div style={{
        textAlign: 'center',
        padding: '24px 0 16px',
        borderBottom: '1px solid var(--border)',
        marginBottom: 16,
      }}>
        <img src="/SLOGO.png" alt="SUNy" style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover', marginBottom: 8 }} />
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{ticket.company_name}</h1>
        {ticket.project_name && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            Project: {ticket.project_name}
          </p>
        )}
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0 0', fontStyle: 'italic' }}>
          {ticket.goal}
        </p>
      </div>

      {/* Messages area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {messages.map((msg, idx) => (
          <div key={idx} style={{
            display: 'flex',
            justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
            marginBottom: 12,
          }}>
            <div style={{
              maxWidth: '75%',
              padding: '10px 14px',
              borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
              background: msg.role === 'user' ? 'var(--accent)' : 'var(--surface)',
              color: msg.role === 'user' ? '#000' : 'var(--text-primary)',
              border: msg.role === 'user' ? 'none' : '1px solid var(--border)',
              fontSize: 14,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
            }}>
              {msg.content}
            </div>
          </div>
        ))}

        {aiThinking && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
            <div style={{
              padding: '10px 14px',
              borderRadius: '16px 16px 16px 4px',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              fontSize: 14,
            }}>
              <div className="thinking-indicator" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <div className="dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-muted)', animation: 'pulse 1s infinite' }} />
                <div className="dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-muted)', animation: 'pulse 1s infinite 0.2s' }} />
                <div className="dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-muted)', animation: 'pulse 1s infinite 0.4s' }} />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Summary (after confirmation) */}
      {confirmed && summary && (
        <div style={{
          padding: 16,
          background: 'rgba(16,185,129,0.06)',
          border: '1px solid rgba(16,185,129,0.2)',
          borderRadius: 12,
          marginBottom: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <CheckCircle size={18} style={{ color: 'var(--success)' }} />
            <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--success)' }}>Confirmed! 🎉</span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>
            {summary}
          </p>
          {suggestions && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
              <strong style={{ color: 'var(--text-secondary)' }}>Next steps:</strong>
              {suggestions}
            </div>
          )}
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
            {ticket.company_name} will review everything and follow up with you. You can close this page now.
          </p>
        </div>
      )}

      {/* Input area */}
      {ticket.status === 'open' && !confirmed && (
        <div style={{
          borderTop: '1px solid var(--border)',
          padding: '12px 0 24px',
          display: 'flex',
          gap: 8,
          alignItems: 'flex-end',
        }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Type your message..."
            rows={2}
            style={{
              flex: 1,
              resize: 'none',
              borderRadius: 12,
              padding: '10px 14px',
              fontSize: 14,
              lineHeight: 1.5,
              minHeight: 44,
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button
              className="btn btn-primary"
              onClick={sendMessage}
              disabled={sending || !input.trim()}
              style={{ borderRadius: 12, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <Send size={16} />
            </button>
            {messages.filter(m => m.role === 'user').length > 1 && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleConfirm}
                disabled={confirmed}
                style={{ fontSize: 11, padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 4 }}
                title="Confirm you've shared all details"
              >
                <CheckCircle size={12} /> Confirm
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
