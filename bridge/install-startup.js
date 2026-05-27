#!/usr/bin/env node
/**
 * bridge/install-startup.js — Install/Remove SUNy Bridge as a Windows startup task.
 *
 * Usage:
 *   node install-startup.js install   # Add to Windows startup
 *   node install-startup.js remove    # Remove from Windows startup
 *   node install-startup.js status    # Check if installed
 *
 * How it works (Windows):
 *   Creates a VBS script in the Windows Startup folder (~/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup)
 *   that launches the bridge silently in a hidden window. On boot/login, the bridge
 *   auto-connects using the saved token from ~/.suny/config.json.
 *
 * On Linux/Mac:
 *   Creates a crontab entry or systemd user service to auto-start on login.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const BRIDGE_DIR = __dirname;
const BRIDGE_SRC = path.join(BRIDGE_DIR, 'src', 'index.ts');

// ── Platform detection ──────────────────────────────────────────────────────

const PLATFORM = process.platform; // 'win32', 'darwin', 'linux'

function getStartupScriptPath() {
  if (PLATFORM === 'win32') {
    const startupFolder = path.join(
      os.homedir(),
      'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'
    );
    return path.join(startupFolder, 'SUNyBridge.vbs');
  }
  // Linux/Mac: using crontab
  return path.join(os.homedir(), '.suny', 'startup.sh');
}

function getVbsContent() {
  return `' SUNy Bridge — hidden startup launcher
' Installed by bridge/install-startup.js
' Uses node from PATH to run the bridge silently.
' The bridge reads ~/.suny/config.json for token/server.

Dim shell, cmd
Set shell = CreateObject("WScript.Shell")

' Run bridge in silent mode with hidden window
cmd = "node """ + BRIDGE_SRC.replace(/\\/g, '\\\\') + """ --silent"
shell.Run cmd, 0, False

Set shell = Nothing
`;
}

function getShContent() {
  return `#!/bin/bash
# SUNy Bridge — auto-start launcher (Linux/Mac)
# Installed by bridge/install-startup.js

cd "${BRIDGE_DIR}"
node src/index.ts --silent &
`;
}

// ── Commands ────────────────────────────────────────────────────────────────

function cmdInstall() {
  if (PLATFORM === 'win32') {
    const scriptPath = getStartupScriptPath();
    const vbs = getVbsContent();
    fs.writeFileSync(scriptPath, vbs, 'utf8');
    console.log(`✅ Bridge startup installed: ${scriptPath}`);
    console.log('   The bridge will auto-connect when you log in to Windows.');
    console.log('   Make sure ~/.suny/config.json has your token saved.');
  } else if (PLATFORM === 'darwin') {
    // macOS: launchd plist with KeepAlive
    const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const plistPath = path.join(plistDir, 'tech.technodel.suny-bridge.plist');
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>tech.technodel.suny-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>node</string>
    <string>${BRIDGE_SRC}</string>
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
    fs.mkdirSync(plistDir, { recursive: true });
    fs.writeFileSync(plistPath, plistContent, 'utf8');
    try {
      execSync(`launchctl load "${plistPath}" 2>/dev/null || true`);
    } catch { /* best-effort */ }
    console.log(`✅ Bridge startup installed: ${plistPath}`);
    console.log('   Bridge will auto-start on login and restart if it crashes.');
  } else {
    // Linux: systemd --user service with Restart=on-failure
    const systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    const servicePath = path.join(systemdDir, 'suny-bridge.service');
    const serviceContent = `[Unit]
Description=SUNy Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=node ${BRIDGE_SRC} --silent
Restart=on-failure
RestartSec=10
StartLimitInterval=60
StartLimitBurst=5

[Install]
WantedBy=default.target
`;
    fs.mkdirSync(systemdDir, { recursive: true });
    fs.writeFileSync(servicePath, serviceContent, 'utf8');
    try {
      execSync('systemctl --user daemon-reload 2>/dev/null');
      execSync('systemctl --user enable suny-bridge.service 2>/dev/null');
      execSync('systemctl --user start suny-bridge.service 2>/dev/null');
      console.log(`✅ Bridge startup installed: ${servicePath}`);
      console.log('   Bridge will auto-start on login and restart if it crashes.');
    } catch {
      // Fallback: crontab @reboot if systemd unavailable
      const startupSh = getStartupScriptPath();
      const shContent = getShContent();
      fs.mkdirSync(path.dirname(startupSh), { recursive: true });
      fs.writeFileSync(startupSh, shContent, 'utf8');
      fs.chmodSync(startupSh, 0o755);
      const cronLine = `@reboot ${startupSh}`;
      try {
        const existingCron = execSync('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });
        if (existingCron.includes(cronLine)) {
          console.log('✅ Bridge cron entry already exists. Skipping.');
        } else {
          const newCron = existingCron.trim() + '\n' + cronLine + '\n';
          execSync(`echo "${newCron}" | crontab -`);
          console.log('✅ Bridge crontab entry added (systemd unavailable — using fallback).');
        }
      } catch (err) {
        console.error('❌ Failed to update crontab:', err.message);
        console.log('   To manually install, add this line to your crontab:');
        console.log(`   ${cronLine}`);
      }
    }
  }
}

function cmdRemove() {
  if (PLATFORM === 'win32') {
    const scriptPath = getStartupScriptPath();
    if (fs.existsSync(scriptPath)) {
      fs.unlinkSync(scriptPath);
      console.log(`✅ Removed bridge startup: ${scriptPath}`);
    } else {
      console.log('ℹ️  Bridge startup is not installed.');
    }
  } else if (PLATFORM === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'tech.technodel.suny-bridge.plist');
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`);
    } catch { /* ignore */ }
    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath);
    }
    console.log('✅ Removed bridge launchd plist.');
  } else {
    // Linux: remove systemd service
    const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'suny-bridge.service');
    try {
      execSync('systemctl --user stop suny-bridge.service 2>/dev/null');
      execSync('systemctl --user disable suny-bridge.service 2>/dev/null');
    } catch { /* ignore */ }
    if (fs.existsSync(servicePath)) {
      fs.unlinkSync(servicePath);
    }
    // Clean crontab fallback if present
    const startupSh = getStartupScriptPath();
    const cronLine = `@reboot ${startupSh}`;
    try {
      const existingCron = execSync('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });
      const filteredCron = existingCron.split('\n').filter(line => !line.includes(cronLine)).join('\n') + '\n';
      execSync(`echo "${filteredCron}" | crontab -`);
    } catch { /* ignore */ }
    if (fs.existsSync(startupSh)) {
      fs.unlinkSync(startupSh);
    }
    console.log('✅ Removed bridge auto-start.');
  }
}

function cmdStatus() {
  if (PLATFORM === 'win32') {
    const scriptPath = getStartupScriptPath();
    if (fs.existsSync(scriptPath)) {
      console.log(`✅ Bridge startup IS installed: ${scriptPath}`);
      const vbs = fs.readFileSync(scriptPath, 'utf8');
      console.log('   Content:');
      console.log('   ─'.repeat(30));
      console.log(vbs.trim().split('\n').map(l => '   ' + l).join('\n'));
      console.log('   ─'.repeat(30));
    } else {
      console.log('ℹ️  Bridge startup is NOT installed.');
      console.log('   Run: node install-startup.js install');
    }
  } else if (PLATFORM === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'tech.technodel.suny-bridge.plist');
    if (fs.existsSync(plistPath)) {
      console.log(`✅ Bridge launchd plist exists: ${plistPath}`);
    } else {
      console.log('ℹ️  Bridge startup is NOT installed.');
      console.log('   Run: node install-startup.js install');
    }
  } else {
    // Linux: check systemd first, then fallback crontab
    const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'suny-bridge.service');
    if (fs.existsSync(servicePath)) {
      console.log(`✅ Bridge systemd service exists: ${servicePath}`);
      return;
    }
    const cronLine = `@reboot ${getStartupScriptPath()}`;
    try {
      const existingCron = execSync('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });
      if (existingCron.includes(cronLine)) {
        console.log('✅ Bridge crontab entry exists.');
      } else {
        console.log('ℹ️  Bridge startup is NOT installed.');
        console.log('   Run: node install-startup.js install');
      }
    } catch (err) {
      console.log('ℹ️  Cannot check startup status:', err.message);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

// Export for programmatic use (e.g. from bridge/src/bridge.ts)
module.exports = { cmdInstall, cmdRemove, cmdStatus, getStartupScriptPath };

const command = process.argv[2] || 'status';

switch (command) {
  case 'install':
    cmdInstall();
    break;
  case 'remove':
    cmdRemove();
    break;
  case 'status':
    cmdStatus();
    break;
  default:
    console.log('Usage: node install-startup.js <install|remove|status>');
    process.exit(1);
}
