import { useState, useEffect } from 'react';
import { Check, Copy, Download } from 'lucide-react';

export default function BridgeInstallInstructions({ autoCopy = false }: { autoCopy?: boolean }) {
  const [cmd, setCmd] = useState('');
  const [winInstallerCmd, setWinInstallerCmd] = useState('');
  const [copied, setCopied] = useState(false);
  const [installerDownloaded, setInstallerDownloaded] = useState(false);
  const isWindows = navigator.userAgent.includes('Windows');

  useEffect(() => {
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
  }, [autoCopy]);

  function copy() {
    if (!cmd) return;
    navigator.clipboard.writeText(cmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
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
    </div>
  );
}
