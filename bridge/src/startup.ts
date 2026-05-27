import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

/**
 * Register or remove the SUNy Bridge as a startup task.
 * Windows: Creates a VBS script in the Startup folder.
 * macOS: Creates a launchd plist in ~/Library/LaunchAgents.
 * Linux: Creates a systemd --user service in ~/.config/systemd/user.
 * Fallback: crontab @reboot if systemd is unavailable.
 */

function getStartupScriptPath(): string {
  if (process.platform === 'win32') {
    return path.join(
      os.homedir(),
      'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'SUNyBridge.vbs',
    );
  }
  return path.join(os.homedir(), '.suny', 'startup.sh');
}

function getBridgeEntryPath(): string {
  if (process.argv[1]) {
    return path.resolve(process.argv[1]);
  }
  return path.join(__dirname, 'index.js');
}

function getVbsContent(): string {
  const bridgeEntry = getBridgeEntryPath();
  return `' SUNy Bridge — hidden startup launcher
' Installed automatically on first connection.
' The bridge reads ~/.suny/config.json for token/server.

Dim shell, cmd
Set shell = CreateObject("WScript.Shell")
cmd = "node """ + "${bridgeEntry.replace(/\\/g, '\\\\')}""" + " --silent"
shell.Run cmd, 0, False
Set shell = Nothing
`;
}

function getShContent(): string {
  const bridgeEntry = getBridgeEntryPath();
  return `#!/bin/bash
# SUNy Bridge — auto-start launcher
cd "${path.dirname(bridgeEntry)}"
node "${bridgeEntry}" --silent &
`;
}

function getSystemdServiceContent(bridgeEntry: string): string {
  return `[Unit]
Description=SUNy Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=node ${bridgeEntry} --silent
Restart=on-failure
RestartSec=10
StartLimitInterval=60
StartLimitBurst=5

[Install]
WantedBy=default.target
`;
}

function getLaunchdPlistContent(bridgeEntry: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>tech.technodel.suny-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>node</string>
    <string>${bridgeEntry}</string>
    <string>--silent</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>${os.homedir()}/.suny/bridge-error.log</string>
  <key>StandardOutPath</key>
  <string>${os.homedir()}/.suny/bridge.log</string>
</dict>
</plist>`;
}

export function installStartup(): boolean {
  try {
    if (process.platform === 'win32') {
      const scriptPath = getStartupScriptPath();
      const vbs = getVbsContent();
      fs.writeFileSync(scriptPath, vbs, 'utf8');
      return true;
    }

    if (process.platform === 'darwin') {
      const bridgeEntry = getBridgeEntryPath();
      const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
      const plistPath = path.join(plistDir, 'tech.technodel.suny-bridge.plist');
      fs.mkdirSync(plistDir, { recursive: true });
      fs.writeFileSync(plistPath, getLaunchdPlistContent(bridgeEntry), 'utf8');
      try {
        execSync(`launchctl load "${plistPath}" 2>/dev/null || true`);
      } catch { /* best-effort */ }
      return true;
    }

    // Linux: systemd --user (modern distros)
    const bridgeEntry = getBridgeEntryPath();
    const systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    const servicePath = path.join(systemdDir, 'suny-bridge.service');
    fs.mkdirSync(systemdDir, { recursive: true });
    fs.writeFileSync(servicePath, getSystemdServiceContent(bridgeEntry), 'utf8');
    try {
      execSync('systemctl --user daemon-reload 2>/dev/null');
      execSync('systemctl --user enable suny-bridge.service 2>/dev/null');
      execSync('systemctl --user start suny-bridge.service 2>/dev/null');
    } catch {
      // Fallback to crontab only if systemd unavailable
      const scriptPath = getStartupScriptPath();
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      fs.writeFileSync(scriptPath, getShContent(), 'utf8');
      fs.chmodSync(scriptPath, 0o755);
      const cronLine = `@reboot ${scriptPath}`;
      try {
        const existingCron = execSync('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });
        if (!existingCron.includes(cronLine)) {
          const newCron = existingCron.trim() + '\n' + cronLine + '\n';
          execSync(`echo "${newCron}" | crontab -`);
        }
      } catch { /* give up */ }
    }
    return true;
  } catch {
    return false;
  }
}

export function removeStartup(): boolean {
  try {
    if (process.platform === 'win32') {
      const scriptPath = getStartupScriptPath();
      if (fs.existsSync(scriptPath)) {
        fs.unlinkSync(scriptPath);
      }
      return true;
    }
    if (process.platform === 'darwin') {
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'tech.technodel.suny-bridge.plist');
      try {
        execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`);
      } catch { /* ignore */ }
      if (fs.existsSync(plistPath)) {
        fs.unlinkSync(plistPath);
      }
      return true;
    }
    // Linux
    const systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    const servicePath = path.join(systemdDir, 'suny-bridge.service');
    try {
      execSync('systemctl --user stop suny-bridge.service 2>/dev/null');
      execSync('systemctl --user disable suny-bridge.service 2>/dev/null');
    } catch { /* ignore */ }
    if (fs.existsSync(servicePath)) {
      fs.unlinkSync(servicePath);
    }
    const scriptPath = getStartupScriptPath();
    const cronLine = `@reboot ${scriptPath}`;
    try {
      const existingCron = execSync('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });
      const filteredCron = existingCron.split('\n').filter((line: string) => !line.includes(cronLine)).join('\n') + '\n';
      execSync(`echo "${filteredCron}" | crontab -`);
    } catch { /* ignore */ }
    if (fs.existsSync(scriptPath)) {
      fs.unlinkSync(scriptPath);
    }
    return true;
  } catch {
    return false;
  }
}

export function isStartupInstalled(): boolean {
  try {
    if (process.platform === 'win32') {
      return fs.existsSync(getStartupScriptPath());
    }
    if (process.platform === 'darwin') {
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'tech.technodel.suny-bridge.plist');
      return fs.existsSync(plistPath);
    }
    // Linux
    const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'suny-bridge.service');
    if (fs.existsSync(servicePath)) return true;
    return fs.existsSync(getStartupScriptPath());
  } catch {
    return false;
  }
}
