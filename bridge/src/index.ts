#!/usr/bin/env node
import { SunyBridge } from './bridge';
import { readConfig, updateConfig } from './config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

function parseArgs(): { token?: string; code?: string; server?: string; register?: string; silent?: boolean; installStartup?: boolean; removeStartup?: boolean } {
  const args = process.argv.slice(2);
  const result: { token?: string; code?: string; server?: string; register?: string; silent?: boolean; installStartup?: boolean; removeStartup?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token' && args[i + 1]) result.token = args[++i];
    else if (args[i] === '--code' && args[i + 1]) result.code = args[++i];
    else if (args[i] === '--server' && args[i + 1]) result.server = args[++i];
    else if (args[i] === '--register' && args[i + 1]) result.register = args[++i];
    else if (args[i] === '--silent' || args[i] === '--background' || args[i] === '-s') result.silent = true;
    else if (args[i] === '--install-startup') result.installStartup = true;
    else if (args[i] === '--remove-startup') result.removeStartup = true;
  }

  return result;
}

// ── Auto-start helpers ──────────────────────────────────────────────────────

function getStartupScriptPath(): string {
  if (process.platform === 'win32') {
    return path.join(
      os.homedir(),
      'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'SUNyBridge.vbs'
    );
  }
  return path.join(os.homedir(), '.suny', 'startup.sh');
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

function installStartup(): void {
  if (process.platform === 'win32') {
    const scriptPath = getStartupScriptPath();
    const bridgeEntry = path.resolve(process.argv[1] || path.join(__dirname, 'index.ts'));
    const vbs = `' SUNy Bridge — hidden startup launcher
' Installed by: suny-bridge --install-startup
' The bridge reads ~/.suny/config.json for token/server.

Dim shell, cmd
Set shell = CreateObject("WScript.Shell")
cmd = "node """ + bridgeEntry.replace(/\\/g, '\\\\') + """ --silent"
shell.Run cmd, 0, False
Set shell = Nothing
`;
    fs.writeFileSync(scriptPath, vbs, 'utf8');
    console.log(`✅ Bridge auto-start installed!`);
    console.log(`   Script: ${scriptPath}`);
    console.log(`   The bridge will auto-connect when you log in to Windows.`);
    return;
  }

  const bridgeEntry = path.resolve(process.argv[1] || path.join(__dirname, 'index.ts'));

  if (process.platform === 'darwin') {
    // macOS: launchd plist with KeepAlive
    const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const plistPath = path.join(plistDir, 'tech.technodel.suny-bridge.plist');
    fs.mkdirSync(plistDir, { recursive: true });
    fs.writeFileSync(plistPath, getLaunchdPlistContent(bridgeEntry), 'utf8');
    try {
      execSync(`launchctl load "${plistPath}" 2>/dev/null || true`);
    } catch { /* best-effort */ }
    console.log(`✅ Bridge auto-start installed! (launchd plist: ${plistPath})`);
    console.log(`   Bridge will auto-start on login and restart if it crashes.`);
    return;
  }

  // Linux: systemd --user service with Restart=on-failure
  const systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const servicePath = path.join(systemdDir, 'suny-bridge.service');
  fs.mkdirSync(systemdDir, { recursive: true });
  fs.writeFileSync(servicePath, getSystemdServiceContent(bridgeEntry), 'utf8');
  try {
    execSync('systemctl --user daemon-reload 2>/dev/null');
    execSync('systemctl --user enable suny-bridge.service 2>/dev/null');
    execSync('systemctl --user start suny-bridge.service 2>/dev/null');
    console.log(`✅ Bridge auto-start installed! (systemd: ${servicePath})`);
    console.log(`   Bridge will auto-start on login and restart if it crashes.`);
  } catch {
    // Fallback: crontab @reboot if systemd unavailable
    const scriptPath = getStartupScriptPath();
    const sh = `#!/bin/bash
# SUNy Bridge — auto-start launcher (crontab fallback)
cd "${__dirname}"
node index.ts --silent &
`;
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, sh, 'utf8');
    fs.chmodSync(scriptPath, 0o755);
    const cronLine = `@reboot ${scriptPath}`;
    try {
      const existingCron = execSync('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });
      if (!existingCron.includes(cronLine)) {
        const newCron = existingCron.trim() + '\n' + cronLine + '\n';
        execSync(`echo "${newCron}" | crontab -`);
        console.log(`✅ Bridge auto-start installed! (crontab @reboot fallback)`);
      }
    } catch {
      console.log('✅ Startup script created. To enable auto-start, add to your crontab:');
      console.log(`   ${cronLine}`);
    }
  }
}

function removeStartup(): void {
  if (process.platform === 'win32') {
    const scriptPath = getStartupScriptPath();
    if (fs.existsSync(scriptPath)) {
      fs.unlinkSync(scriptPath);
      console.log('✅ Bridge auto-start removed.');
    } else {
      console.log('ℹ️  Bridge auto-start was not installed.');
    }
    return;
  }

  if (process.platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'tech.technodel.suny-bridge.plist');
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`);
    } catch { /* ignore */ }
    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath);
    }
    console.log('✅ Bridge launchd plist removed.');
    return;
  }

  // Linux: systemd --user
  const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'suny-bridge.service');
  try {
    execSync('systemctl --user stop suny-bridge.service 2>/dev/null');
    execSync('systemctl --user disable suny-bridge.service 2>/dev/null');
  } catch { /* ignore */ }
  if (fs.existsSync(servicePath)) {
    fs.unlinkSync(servicePath);
  }
  // Also clean crontab fallback if present
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
  console.log('✅ Bridge auto-start removed.');
}

function toHttpApiBase(server: string): string {
  if (server.startsWith('wss://')) return `https://${server.slice(6)}`;
  if (server.startsWith('ws://')) return `http://${server.slice(5)}`;
  return server.replace(/\/$/, '');
}

async function redeemSetupCode(server: string, code: string): Promise<string> {
  const apiBase = toHttpApiBase(server);
  const response = await fetch(`${apiBase}/api/bridge/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });

  let data: { token?: string; error?: string } = {};
  try {
    data = (await response.json()) as { token?: string; error?: string };
  } catch {
    // Ignore JSON parse failures and fall back to status text below.
  }

  if (!response.ok || !data.token) {
    throw new Error(data.error || `Setup code activation failed (${response.status})`);
  }

  return data.token;
}

async function main(): Promise<void> {
  const args = parseArgs();

  // Handle startup installation flags (no token needed)
  if (args.installStartup) {
    installStartup();
    return;
  }
  if (args.removeStartup) {
    removeStartup();
    return;
  }

  const config = readConfig();

  // Handle registration of a project directory
  if (args.register) {
    const { registerPath } = require('./config');
    registerPath(args.register);
    if (!args.silent) console.log(`[SUNy Bridge] Registered project directory: ${args.register}`);
    return;
  }

  // Persist token and server if provided
  if (args.token) updateConfig({ token: args.token });
  if (args.server) updateConfig({ server: args.server });

  let token = args.token || config.token;
  const server = args.server || config.server || 'wss://suny.technodel.tech';

  if (!token && args.code) {
    if (!args.silent) console.log('[SUNy Bridge] Redeeming setup code...');
    token = await redeemSetupCode(server, args.code);
    updateConfig({ token, server });
  }

  // No token? Start UI-based auto-setup for non-technical users
  if (!token && !args.silent) {
    console.log('[SUNy Bridge] First-time setup starting...');
    const result = await runUiSetup(server);
    token = result.token;
    updateConfig({ token, server: result.server });
    console.log('[SUNy Bridge] Setup complete! Connecting...');
  }

  if (!token) {
    console.error('[SUNy Bridge] Setup required. Please visit https://suny.technodel.tech to connect your bridge.');
    process.exit(1);
  }

  const bridge = new SunyBridge(token, server, { silent: args.silent });

  process.on('SIGINT', () => {
    if (!args.silent) console.log('\n[SUNy Bridge] Shutting down...');
    bridge.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    bridge.stop();
    process.exit(0);
  });

  if (!args.silent) console.log(`[SUNy Bridge] Starting — connecting to ${server}`);
  bridge.start();
}

main().catch((err) => {
  console.error('[SUNy Bridge] Startup failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
