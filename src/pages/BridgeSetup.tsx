import { useState, useEffect, useRef } from 'react';
import { Copy, CheckCircle } from 'lucide-react';

interface BridgeSetupProps {
  onConnected: () => void;
}

export default function BridgeSetup({ onConnected }: BridgeSetupProps) {
  const [copied, setCopied] = useState(false);
  const [waitingTimer, setWaitingTimer] = useState(0);
  const [token, setToken] = useState('');
  const autoCopied = useRef(false);

  const isDevMode = import.meta.env.DEV;
  const serverUrl = isDevMode
    ? 'ws://localhost:3500'
    : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
  const bridgeTgzUrl = `${window.location.protocol}//${window.location.host}/bridge/gaby-bridge.tgz`;
  const installCmd = token
    ? `npm install -g ${bridgeTgzUrl} && gaby-bridge start --token ${token} --server ${serverUrl}`
    : 'Loading…';

  // Fetch bridge token from server (cookie is httpOnly, can't read directly)
  useEffect(() => {
    fetch('/api/bridge-token', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.token) {
          setToken(data.token);
        }
      });
  }, []);

  // Auto-copy command once token is ready
  useEffect(() => {
    if (token && !autoCopied.current) {
      autoCopied.current = true;
      navigator.clipboard.writeText(installCmd).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [token, serverUrl]);

  useEffect(() => {
    const interval = setInterval(() => {
      setWaitingTimer(t => t + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Poll for bridge connection
  useEffect(() => {
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/api/me', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          if (data.bridge_connected) {
            clearInterval(poll);
            onConnected();
          }
        }
      } catch {
        // ignore
      }
    }, 2000);
    return () => clearInterval(poll);
  }, [onConnected]);

  function copyCommand() {
    navigator.clipboard.writeText(installCmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg)',
      padding: 20,
    }}>
      <div style={{ width: '100%', maxWidth: 560 }} className="page-enter">
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <img src="/SUNy.png" alt="SUNy" style={{ width: 288, height: 288, borderRadius: '50%', objectFit: 'cover', boxShadow: '0 4px 20px rgba(108,99,255,0.3)' }} />
        </div>
        <div className="card">
          <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>🔌 One quick setup step</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.6 }}>
            GABy works directly on your computer's files.
            You just need to install the GABy Bridge — it takes about 30 seconds.
          </p>

          <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
            Open your terminal and run:
          </div>
          <div style={{
            background: '#0a0b0f',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '12px 14px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            marginBottom: 20,
          }}>
            <code style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
              color: 'var(--success)',
              wordBreak: 'break-all',
              flex: 1,
            }}>
              {installCmd}
            </code>
            <button
              className="btn btn-secondary btn-sm btn-icon"
              onClick={copyCommand}
              title="Copy command"
            >
              {copied ? <CheckCircle size={14} color="var(--success)" /> : <Copy size={14} />}
            </button>
          </div>

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: 'var(--text-secondary)',
            fontSize: 13,
          }}>
            <div style={{ display: 'flex', gap: 4 }}>
              {[1, 2, 3].map(i => (
                <span key={i} className={`dot-${i}`} style={{
                  display: 'inline-block',
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--accent)',
                }} />
              ))}
            </div>
            <span>⏳ Waiting for GABy Bridge to connect... ({waitingTimer}s)</span>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
            This page updates automatically when the Bridge connects.
          </p>

          {/* OS-specific notes */}
          <details style={{ marginTop: 20 }}>
            <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 13 }}>
              What is GABy Bridge?
            </summary>
            <p style={{ marginTop: 10, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              GABy Bridge is a tiny helper app that lets GABy work directly inside your project folders.
              It runs quietly in the background and doesn't collect any data.
              It only operates within folders you choose to share with GABy.
            </p>
          </details>
        </div>
      </div>
    </div>
  );
}
