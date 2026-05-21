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

  // Reconnect command (works when the saved bridge token is still valid)
  const restartCmd = 'suny-bridge start --silent';

  // Show smart reconnect for users who already set up the bridge
  const isReconnect = previouslyConnected === true;

  function buildSetupCommands(token: string): void {
    const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const serverUrl = import.meta.env.DEV ? 'ws://localhost:3500' : `${wsProto}://${window.location.host}`;
    const tgzUrl = `${window.location.protocol}//${window.location.host}/bridge/suny-bridge.tgz`;
    const c = `npm install -g ${tgzUrl} ; npx suny-bridge start --token ${token} --server ${serverUrl}`;
    const exeUrl = `${window.location.protocol}//${window.location.host}/bridge/suny-bridge.exe`;
    const winCmd = `@echo off\r\ntitle SUNy Bridge Setup\r\ncolor 0A\r\nset BRIDGE_DIR=%APPDATA%\\suny-bridge\r\nif not exist "%BRIDGE_DIR%" mkdir "%BRIDGE_DIR%"\r\nif not exist "%BRIDGE_DIR%\\suny-bridge.exe" (\r\n  echo Downloading SUNy Bridge... (may take 30-60 seconds)\r\n  powershell -Command "Invoke-WebRequest -Uri '${exeUrl}' -OutFile '%APPDATA%\\\\suny-bridge\\\\suny-bridge.exe' -UseBasicParsing"\r\n  if errorlevel 1 (\r\n    echo.\r\n    echo Download failed. Check your internet connection.\r\n    pause\r\n    exit /b 1\r\n  )\r\n  echo Download complete.\r\n)\r\necho.\r\necho Starting SUNy Bridge...\r\n"%BRIDGE_DIR%\\suny-bridge.exe" --token ${token} --server ${serverUrl}\r\n`;
    setCmd(c);
    setWinInstallerCmd(winCmd);
    if (autoCopy && !isReconnect) {
      navigator.clipboard.writeText(c).then(() => { setCopied(true); setTimeout(() => setCopied(false), 3000); }).catch(() => {});
    }
  }

  useEffect(() => {
    // For reconnect mode, also fetch a fresh setup command in case the saved token expired.
    // For first-time install, this is the main install command.
    fetch('/api/bridge-token', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.token) return;
        buildSetupCommands(data.token);
      });
  }, [isReconnect]);

  useEffect(() => {
    if (isReconnect) {
      // Already installed — just show restart command
      // Auto-copy the restart command
      if (autoCopy) {
        navigator.clipboard.writeText(restartCmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 3000); }).catch(() => {});
      }
      return;
    }
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
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
          Bridge disconnected. Reconnect with one click:
        </p>

        {isWindows ? (
          <>
            {/* PRIMARY: one-click .cmd installer with fresh token */}
            <button
              className="btn btn-primary"
              onClick={downloadWindowsInstaller}
              disabled={!winInstallerCmd}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px', fontSize: 14, fontWeight: 600 }}
              title="Download one-click reconnect file"
            >
              <Download size={16} />
              {installerDownloaded ? 'Downloaded — now double-click it!' : !winInstallerCmd ? 'Loading…' : 'Download reconnect file'}
            </button>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.5, textAlign: 'center' }}>
              Click the button → open your <strong>Downloads</strong> folder → <strong>double-click</strong> the file.
              <br />
              That's it. No terminal, no copy-paste.
            </p>
          </>
        ) : (
          <>
            {/* Non-Windows fallback: show the restart command */}
            <div style={{ position: 'relative', background: 'var(--bg)', border: `1px solid ${copied ? 'var(--success)' : 'var(--border)'}`, borderRadius: 'var(--radius)', padding: '10px 44px 10px 12px', fontFamily: 'monospace', fontSize: 12, color: 'var(--accent)', wordBreak: 'break-all', lineHeight: 1.6 }}>
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
              Copy this command, open your Terminal, and paste it.
            </p>
          </>
        )}

        {/* Advanced fallback */}
        <details style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text-muted)' }}>
            Advanced: use terminal command instead
          </summary>
          <div style={{ marginTop: 8 }}>
            <p style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 6 }}>
              If you prefer the terminal, run:
            </p>
            <div style={{ position: 'relative', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 40px 8px 10px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-primary)', wordBreak: 'break-all', lineHeight: 1.5 }}>
              {restartCmd}
              <button
                onClick={copy}
                style={{ position: 'absolute', top: 6, right: 6, background: copied ? 'var(--success)' : 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', color: copied ? '#fff' : 'var(--text-muted)', padding: '2px 5px', fontSize: 10, display: 'flex', alignItems: 'center', gap: 3 }}
                title="Copy command"
              >
                {copied ? <Check size={10} /> : <Copy size={10} />}
              </button>
            </div>
            {cmd && (
              <>
                <p style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: 8, marginBottom: 6 }}>
                  Or if the saved config was lost, run the full setup command:
                </p>
                <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontFamily: 'monospace', fontSize: 10, color: 'var(--text-primary)', wordBreak: 'break-all', lineHeight: 1.5 }}>
                  {cmd}
                </div>
              </>
            )}
          </div>
        </details>
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
