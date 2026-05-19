#!/usr/bin/env node
import { SunyBridge } from './bridge';
import { readConfig, updateConfig } from './config';

function parseArgs(): { token?: string; code?: string; server?: string; register?: string; silent?: boolean } {
  const args = process.argv.slice(2);
  const result: { token?: string; code?: string; server?: string; register?: string; silent?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token' && args[i + 1]) result.token = args[++i];
    else if (args[i] === '--code' && args[i + 1]) result.code = args[++i];
    else if (args[i] === '--server' && args[i + 1]) result.server = args[++i];
    else if (args[i] === '--register' && args[i + 1]) result.register = args[++i];
    else if (args[i] === '--silent' || args[i] === '--background' || args[i] === '-s') result.silent = true;
  }

  return result;
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
