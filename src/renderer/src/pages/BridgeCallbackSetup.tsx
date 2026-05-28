import { useState, useEffect } from 'react';
import { CheckCircle, Loader2, AlertCircle } from 'lucide-react';

/**
 * Bridge Callback Setup Page
 * 
 * Zero-command bridge setup flow:
 * 1. Bridge opens browser to /bridge-setup?callback=http://localhost:PORT
 * 2. This page reads callback URL and shows "Connect Bridge" button
 * 3. When clicked, calls server to send token to the callback URL
 * 4. Bridge receives token and connects automatically
 */
export default function BridgeCallbackSetup() {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'success' | 'error'>('idle');
  const [error, setError] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');

  // Read callback URL from query params on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const callback = params.get('callback');
    if (callback) {
      setCallbackUrl(callback);
    }
  }, []);

  async function handleConnect() {
    if (!callbackUrl) {
      setError('Missing callback URL. Please restart the bridge.');
      setStatus('error');
      return;
    }

    setStatus('connecting');
    setError('');

    try {
      const response = await fetch('/api/bridge/callback-setup', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callbackUrl }),
      });

      if (response.ok) {
        setStatus('success');
        // Close window after 3 seconds
        setTimeout(() => {
          window.close();
        }, 3000);
      } else {
        const data = await response.json().catch(() => ({}));
        setError(data.error || 'Failed to connect bridge. Please try again.');
        setStatus('error');
      }
    } catch {
      setError('Network error. Please check your connection and try again.');
      setStatus('error');
    }
  }

  // If no callback URL, show error
  if (!callbackUrl) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        padding: 20,
      }}>
        <div style={{ textAlign: 'center', maxWidth: 400 }}>
          <AlertCircle size={64} color="var(--danger)" style={{ marginBottom: 20 }} />
          <h2 style={{ fontSize: 24, fontWeight: 600, marginBottom: 12 }}>Invalid Setup URL</h2>
          <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            This page should be opened automatically by the SUNy Bridge. 
            Please run the bridge first.
          </p>
        </div>
      </div>
    );
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
      <div style={{ width: '100%', maxWidth: 480, textAlign: 'center' }}>
        {/* Logo */}
        <div style={{ marginBottom: 32 }}>
          <img 
            src="/SLOGO.png" 
            alt="SUNy" 
            style={{ 
              width: 120, 
              height: 120, 
              borderRadius: '50%', 
              objectFit: 'cover',
              boxShadow: '0 4px 20px rgba(108,99,255,0.3)'
            }} 
          />
        </div>

        {/* Card */}
        <div className="card" style={{ padding: 32 }}>
          {status === 'idle' && (
            <>
              <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}>
                🔌 Connect SUNy Bridge
              </h2>
              <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 24 }}>
                Click the button below to authorize the bridge running on your computer.
                This gives SUNy access to work with your local files.
              </p>
              <button
                onClick={handleConnect}
                style={{
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  padding: '14px 32px',
                  borderRadius: 8,
                  fontSize: 16,
                  fontWeight: 600,
                  cursor: 'pointer',
                  width: '100%',
                }}
              >
                Connect Bridge
              </button>
            </>
          )}

          {status === 'connecting' && (
            <>
              <Loader2 size={48} color="var(--accent)" style={{ margin: '0 auto 20px', animation: 'spin 1s linear infinite' }} />
              <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>Connecting...</h2>
              <p style={{ color: 'var(--text-secondary)' }}>
                Sending authorization to your local bridge...
              </p>
            </>
          )}

          {status === 'success' && (
            <>
              <CheckCircle size={64} color="var(--success)" style={{ margin: '0 auto 20px' }} />
              <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 12, color: 'var(--success)' }}>
                Bridge Connected!
              </h2>
              <p style={{ color: 'var(--text-secondary)' }}>
                Your bridge is now connected. This window will close automatically.
              </p>
            </>
          )}

          {status === 'error' && (
            <>
              <AlertCircle size={64} color="var(--danger)" style={{ margin: '0 auto 20px' }} />
              <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 12, color: 'var(--danger)' }}>
                Connection Failed
              </h2>
              <p style={{ color: 'var(--text-secondary)', marginBottom: 20 }}>
                {error}
              </p>
              <button
                onClick={() => setStatus('idle')}
                style={{
                  background: 'var(--surface)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  padding: '12px 24px',
                  borderRadius: 8,
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Try Again
              </button>
            </>
          )}
        </div>

        {/* Footer info */}
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 20 }}>
          The bridge runs locally on your machine and only accesses folders you choose to share.
        </p>
      </div>
    </div>
  );
}

// Add spin animation
const style = document.createElement('style');
style.textContent = `
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
`;
document.head.appendChild(style);
