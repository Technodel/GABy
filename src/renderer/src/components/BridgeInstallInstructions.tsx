import { useState, useEffect } from 'react';
import { Check, Copy, Download } from 'lucide-react';

interface Props {
  autoCopy?: boolean;
  previouslyConnected?: boolean;
}

export default function BridgeInstallInstructions({ autoCopy = false, previouslyConnected }: Props) {
  const [cmd, setCmd] = useState('');
  const [winInstallerCmd, setWinInstallerCmd] = useState('');
  const [copied, setCopied] = useState(false);
  const [installerDownloaded, setInstallerDownloaded] = useState(false);
  const isWindows = navigator.userAgent.includes('Windows');

  // Reconnect command (no token needed — bridge reads ~/.suny/config.json)
  const restartCmd = 'suny-bridge start --silent';

  // Show smart reconnect for users who already set up the bridge
  const isReconnect = previouslyConnected === true;

  useEffect(() => {
    if (isReconnect) {
      // Already installed — just show restart command
      // Auto-copy the restart command
      if (autoCopy) {
        navigator.clipboard.writeText(restartCmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 3000); }).catch(() => {});
      }
      return;
    }

    // Full install flow for first-time users
    fetch('/api/bridge-token', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.token) return;
        const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const serverUrl = import.meta.env.DEV ? 'ws://localhost:3500' : `${wsProto}://${window.location.host}`;
        const tgzUrl = `${window.location.protocol}//${window.location.host}/bridge/suny-bridge.tgz`;
        const c = `npm install -g ${tgzUrl} ; npx suny-bridge start --token ${data.token} --server ${serverUrl}`;
        const exeUrl = `${window.location.protocol}//${window.location.host}/bridge/suny-bridge.exe`;
        const winCmd = `@echo off\r\ntitle SUNy Bridge Setup\r\ncolor 0A\r\nset BRIDGE_DIR=%APPDATA%\\suny-bridge\r\nif not exist "%BRIDGE_DIR%" mkdir "%BRIDGE_DIR%"\r\nif not exist "%BRIDGE_DIR%\\suny-bridge.exe" (\r\n  echo Downloading SUNy Bridge... (may take 30-60 seconds)\r\n  powershell -Command "Invoke-WebRequest -Uri '${exeUrl}' -OutFile '%APPDATA%\\\\suny-bridge\\\\suny-bridge.exe' -UseBasicParsing"\r\n  if errorlevel 1 (\r\n    echo.\r\n    echo Download failed. Check your internet connection.\r\n    pause\r\n    exit /b 1\r\n  )\r\n  echo Download complete.\r\n)\r\necho.\r\necho Starting SUNy Bridge...\r\n"%BRIDGE_DIR%\\suny-bridge.exe" --token ${data.token} --server ${serverUrl}\r\n`;
        setCmd(c);
        setWinInstallerCmd(winCmd);
        if (autoCopy) {
          navigator.clipboard.writeText(c).then(() => { setCopied(true); setTimeout(() => setCopied(false), 3000); }).catch(() => {});
        }
      });
  }, [autoCopy, isReconnect, restartCmd]);

  function copy() {
    const text = isReconnect ? restartCmd : cmd;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  function downloadWindowsInstaller() {
    if (!isWindows || !winInstallerCmd) return;
    const blob = new Blob([winInstallerCmd], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'install-suny-bridge.cmd';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setInstallerDownloaded(true);
    setTimeout(() => setInstallerDownloaded(false), 5000);
  }

  // ── Reconnect view (already installed) ──────────────────────────────────
  if (isReconnect) {
    return (
      <div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.5 }}>
          ✅ Bridge is already installed on your machine. Just restart it:
        </p>

        {/* Step guide */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 10 }}>
          {[
            { n: '1', label: copied ? '✓ Copied!' : 'Copy command', done: copied },
            { n: '2', label: `Open ${isWindows ? 'PowerShell / CMD' : 'Terminal'}`, done: false },
            { n: '3', label: 'Paste & press Enter', done: false },
          ].map((s, i) => (
            <div key={i} style={{ flex: 1, textAlign: 'center', fontSize: 11, color: s.done ? 'var(--success)' : 'var(--text-muted)' }}>
              <div style={{
                width: 22, height: 22, borderRadius: '50%', margin: '0 auto 4px',
                background: s.done ? 'var(--success)' : 'var(--surface)',
                border: `1px solid ${s.done ? 'var(--success)' : 'var(--border)'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, fontWeight: 700, color: s.done ? '#fff' : 'var(--text-muted)',
              }}>{s.done ? '✓' : s.n}</div>
              {s.label}
            </div>
          ))}
        </div>

        {/* Command box */}
        <div style={{ position: 'relative', background: 'var(--bg)', border: `1px solid ${copied ? 'var(--success)' : 'var(--border)'}`, borderRadius: 'var(--radius)', padding: '10px 44px 10px 12px', fontFamily: 'monospace', fontSize: 12, color: 'var(--accent)', wordBreak: 'break-all', lineHeight: 1.6, transition: 'border-color 0.2s' }}>
          {restartCmd}
          <button
            onClick={copy}
            style={{ position: 'absolute', top: 8, right: 8, background: copied ? 'var(--success)' : 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', color: copied ? '#fff' : 'var(--text-muted)', padding: '3px 6px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
            title="Copy command"
          >
            {copied ? <><Check size={12} /> Copied!</> : <><Copy size={12} /> Copy</>}
          </button>
        </div>

        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
          The bridge saves your connection info in <code style={{ fontSize: 11 }}>~/.suny/config.json</code>.
          Just run this command to reconnect — no need to install or generate new tokens.
          {isWindows && ' After the first connection, the bridge will auto-start on every boot.'}
        </p>

        {autoCopy && (
          <p style={{ fontSize: 11, color: copied ? 'var(--success)' : 'var(--text-muted)', marginTop: 6, transition: 'color 0.3s' }}>
            {copied ? '✓ Command copied — open a terminal and paste.' : 'Click Copy above, then paste in your terminal.'}
          </p>
        )}

        {/* Fallback for when config was lost */}
        {cmd && (
          <details style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text-muted)' }}>
              Not working? Use full setup command
            </summary>
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 6 }}>
                If the saved config was lost, run the full setup command (re-installs with a fresh token):
              </p>
              <div style={{ position: 'relative', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 40px 8px 10px', fontFamily: 'monospace', fontSize: 10, color: 'var(--text-primary)', wordBreak: 'break-all', lineHeight: 1.5 }}>
                {cmd}
              </div>
            </div>
          </details>
        )}
      </div>
    );
  }

  // ── First-time install view ─────────────────────────────────────────────
  return (
    <div>
      {/* Step guide */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 10 }}>
        {[
          { n: '1', label: copied ? '✓ Copied!' : 'Copy command', done: copied },
          { n: '2', label: `Open ${isWindows ? 'PowerShell / CMD' : 'Terminal'}`, done: false },
          { n: '3', label: 'Paste & press Enter', done: false },
        ].map((s, i) => (
          <div key={i} style={{ flex: 1, textAlign: 'center', fontSize: 11, color: s.done ? 'var(--success)' : 'var(--text-muted)' }}>
            <div style={{
              width: 22, height: 22, borderRadius: '50%', margin: '0 auto 4px',
              background: s.done ? 'var(--success)' : 'var(--surface)',
              border: `1px solid ${s.done ? 'var(--success)' : 'var(--border)'}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, fontWeight: 700, color: s.done ? '#fff' : 'var(--text-muted)',
            }}>{s.done ? '✓' : s.n}</div>
            {s.label}
          </div>
        ))}
      </div>

      {/* Command box */}
      <div style={{ position: 'relative', background: 'var(--bg)', border: `1px solid ${copied ? 'var(--success)' : 'var(--border)'}`, borderRadius: 'var(--radius)', padding: '10px 44px 10px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-primary)', wordBreak: 'break-all', lineHeight: 1.6, transition: 'border-color 0.2s' }}>
        {cmd || 'Loading...'}
        {cmd && (
          <button
            onClick={copy}
            style={{ position: 'absolute', top: 8, right: 8, background: copied ? 'var(--success)' : 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', color: copied ? '#fff' : 'var(--text-muted)', padding: '3px 6px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
            title="Copy command"
          >
            {copied ? <><Check size={12} /> Copied!</> : <><Copy size={12} /> Copy</>}
          </button>
        )}
      </div>

      {isWindows && (
        <div style={{ marginTop: 8 }}>
          <button
            className="btn btn-secondary"
            onClick={downloadWindowsInstaller}
            disabled={!winInstallerCmd}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            title="Download one-click installer"
          >
            <Download size={14} />
            {installerDownloaded ? 'Installer downloaded!' : 'Download one-click installer (.cmd)'}
          </button>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
            No Node.js required. Double-click the file — it downloads the bridge and connects automatically.
          </p>
        </div>
      )}

      {autoCopy && cmd && (
        <p style={{ fontSize: 11, color: copied ? 'var(--success)' : 'var(--text-muted)', marginTop: 6, transition: 'color 0.3s' }}>
          {copied ? '✓ Command copied to clipboard — now open a terminal and paste.' : 'Click Copy above, then paste in your terminal.'}
        </p>
      )}

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
        💡 After the first connection, the bridge will <strong>auto-start on every boot</strong>.
        Next time you just need to run <code style={{ fontSize: 11 }}>suny-bridge start --silent</code> to reconnect.
      </p>
    </div>
  );
}
