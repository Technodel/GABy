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

function installStartup(): void {
  if (process.platform === 'win32') {
    const scriptPath = getStartupScriptPath();
    const bridgeIndex = path.join(__dirname, 'index.ts');
    const vbs = `' SUNy Bridge — hidden startup launcher
' Installed by: suny-bridge --install-startup
' The bridge reads ~/.suny/config.json for token/server.

Dim shell, cmd
Set shell = CreateObject("WScript.Shell")
cmd = "node """ + bridgeIndex.replace(/\\/g, '\\\\') + """ --silent"
shell.Run cmd, 0, False
Set shell = Nothing
`;
    fs.writeFileSync(scriptPath, vbs, 'utf8');
    console.log(`✅ Bridge auto-start installed!`);
    console.log(`   Script: ${scriptPath}`);
    console.log(`   The bridge will auto-connect when you log in to Windows.`);
  } else {
    // Linux/Mac: create a shell script + crontab entry
    const scriptPath = getStartupScriptPath();
    const bridgeIndex = path.join(__dirname, 'index.ts');
    const sh = `#!/bin/bash
# SUNy Bridge — auto-start launcher
cd "${__dirname}"
node index.ts --silent &
`;
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, sh, 'utf8');
    fs.chmodSync(scriptPath, 0o755);

    const cronLine = `@reboot ${scriptPath}`;
    try {
      const existingCron = execSync('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });
      if (existingCron.includes(cronLine)) {
        console.log('✅ Bridge crontab entry already exists. Startup is set up.');
      } else {
        const newCron = existingCron.trim() + '\n' + cronLine + '\n';
        execSync(`echo "${newCron}" | crontab -`);
        console.log('✅ Bridge auto-start installed! (crontab @reboot)');
      }
    } catch (err) {
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
  } else {
    const scriptPath = getStartupScriptPath();
    const cronLine = `@reboot ${scriptPath}`;
    try {
      const existingCron = execSync('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });
      const filteredCron = existingCron.split('\n').filter((line: string) => !line.includes(cronLine)).join('\n') + '\n';
      execSync(`echo "${filteredCron}" | crontab -`);
      console.log('✅ Bridge crontab entry removed.');
    } catch (err) {
      console.log('ℹ️  Could not update crontab:', (err as Error).message);
    }
    if (fs.existsSync(scriptPath)) {
      fs.unlinkSync(scriptPath);
    }
  }
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

  if (!token) {
    if (!args.silent) {
      console.error('[SUNy Bridge] No token provided. Run with --token <JWT> or --code <SETUP_CODE>');
      console.error('  Example: suny-bridge start --code SUNY-XXXXX-XXXXX --server wss://suny.technodel.tech');
    }
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
