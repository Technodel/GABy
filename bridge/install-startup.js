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
  } else {
    // Linux/Mac: Add crontab entry
    const startupSh = getStartupScriptPath();
    const shContent = getShContent();
    fs.mkdirSync(path.dirname(startupSh), { recursive: true });
    fs.writeFileSync(startupSh, shContent, 'utf8');
    fs.chmodSync(startupSh, 0o755);

    // Add to crontab
    const cronLine = `@reboot ${startupSh}`;
    try {
      const existingCron = execSync('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });
      if (existingCron.includes(cronLine)) {
        console.log('✅ Bridge cron entry already exists. Skipping.');
      } else {
        const newCron = existingCron.trim() + '\n' + cronLine + '\n';
        execSync(`echo "${newCron}" | crontab -`);
        console.log('✅ Bridge crontab entry added. It will auto-start on boot.');
      }
    } catch (err) {
      console.error('❌ Failed to update crontab:', err.message);
      console.log('   To manually install, add this line to your crontab:');
      console.log(`   ${cronLine}`);
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
  } else {
    // Remove from crontab
    const startupSh = getStartupScriptPath();
    const cronLine = `@reboot ${startupSh}`;
    try {
      const existingCron = execSync('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });
      const filteredCron = existingCron.split('\n').filter(line => !line.includes(cronLine)).join('\n') + '\n';
      execSync(`echo "${filteredCron}" | crontab -`);
      console.log('✅ Removed bridge crontab entry.');
    } catch (err) {
      console.error('❌ Failed to update crontab:', err.message);
    }
    // Remove the script
    if (fs.existsSync(startupSh)) {
      fs.unlinkSync(startupSh);
    }
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
  } else {
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
      console.log('ℹ️  Cannot check crontab:', err.message);
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
