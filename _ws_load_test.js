#!/usr/bin/env node
/**
 * _ws_load_test.js
 * WebSocket rate-limiter load test for SUNy.
 *
 * Usage:
 *   node _ws_load_test.js [options]
 *
 * Options:
 *   --host    <url>   WebSocket host (default: wss://suny.technodel.tech)
 *   --users   <n>     Concurrent users / connections (default: 10)
 *   --msgs    <n>     Messages per connection (default: 20)
 *   --delay   <ms>    Delay between messages per connection (default: 200ms)
 *   --token   <jwt>   Auth token (overrides USERNAME/PASSWORD login)
 *   --user    <name>  Username for login (default: testbench)
 *   --pass    <str>   Password for login (default: testbench123)
 *   --scenario <name> flood | multi | burst (default: flood)
 *
 * Scenarios:
 *   flood   — one user, rapid fire (finds single-user rate limit)
 *   multi   — N users all sending at once (finds per-IP/global limit)
 *   burst   — N users pause then all send simultaneously (tests burst detection)
 */

'use strict';

const WebSocket = require('ws');
const https = require('https');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

const WS_HOST  = getArg('--host',     'wss://suny.technodel.tech');
const HTTP_HOST = WS_HOST.replace(/^wss?:\/\//, 'https://');
const N_USERS   = parseInt(getArg('--users',  '10'), 10);
const N_MSGS    = parseInt(getArg('--msgs',   '20'), 10);
const MSG_DELAY = parseInt(getArg('--delay',  '200'), 10);
const SCENARIO  = getArg('--scenario', 'flood');
const CLI_TOKEN = getArg('--token', '');
const CLI_USER  = getArg('--user',  'testbench');
const CLI_PASS  = getArg('--pass',  'testbench123');

// ── ANSI colours ──────────────────────────────────────────────────────────────
const R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m';
const C = '\x1b[36m', B = '\x1b[1m',  X = '\x1b[0m';

// ── Rate-limit detection patterns ─────────────────────────────────────────────
const RATE_LIMIT_PATTERNS = [
  'too many',
  'rate limit',
  'slow down',
  'throttl',
  'flood',
  '429',
];

function isRateLimited(text) {
  const lower = (text || '').toLowerCase();
  return RATE_LIMIT_PATTERNS.some(p => lower.includes(p));
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpsPost(urlStr, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(urlStr);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      rejectUnauthorized: false,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function login() {
  const r = await httpsPost(`${HTTP_HOST}/api/auth/login`, { username: CLI_USER, password: CLI_PASS });
  if (r.status !== 200) throw new Error(`Login failed HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  const parsed = JSON.parse(r.body);
  const token = parsed.token || parsed.access_token;
  if (!token) throw new Error('No token in login response');
  return token;
}

// ── Single connection worker ───────────────────────────────────────────────────
function runConnection(token, connectionId, nMsgs, msgDelay, startSignal) {
  return new Promise((resolve) => {
    const wsUrl = `${WS_HOST}/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl, { rejectUnauthorized: false });

    const stats = {
      connectionId,
      connected: false,
      messagesSent: 0,
      responsesReceived: 0,
      rateLimitedAt: null, // message number when first rate-limited
      rateLimitCount: 0,
      errors: 0,
      firstResponseMs: null,
      connectMs: null,
      connectStart: Date.now(),
      done: false,
    };

    const pending = new Map(); // msgN → { sentAt }
    let msgN = 0;

    async function sendMessages() {
      // Wait for the start signal (used for burst scenario)
      await startSignal;
      for (let i = 0; i < nMsgs; i++) {
        if (stats.done) break;
        if (ws.readyState !== WebSocket.OPEN) break;
        msgN++;
        const sessionId = `load_test_${connectionId}_${msgN}`;
        const payload = JSON.stringify({
          type: 'chat:message',
          message: `Load test ping ${connectionId}-${msgN}`,
          sessionId,
          mode: 'fast',
        });
        pending.set(sessionId, { msgN, sentAt: Date.now() });
        ws.send(payload);
        stats.messagesSent++;
        if (i < nMsgs - 1) await sleep(msgDelay);
      }
    }

    ws.on('open', () => {
      stats.connected = true;
      stats.connectMs = Date.now() - stats.connectStart;
      sendMessages().catch(() => {});
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.event === 'suny:stream_end' || msg.event === 'suny:stream_chunk') {
          stats.responsesReceived++;
          const content = msg.content || msg.chunk || '';
          if (stats.firstResponseMs === null) {
            stats.firstResponseMs = Date.now() - stats.connectStart;
          }
          if (isRateLimited(content)) {
            if (stats.rateLimitedAt === null) stats.rateLimitedAt = stats.messagesSent;
            stats.rateLimitCount++;
          }
        }
      } catch { /* non-JSON preamble */ }
    });

    ws.on('error', (err) => {
      stats.errors++;
      if (err.message.includes('429') || err.message.toLowerCase().includes('rate')) {
        if (stats.rateLimitedAt === null) stats.rateLimitedAt = stats.messagesSent;
        stats.rateLimitCount++;
      }
    });

    ws.on('close', () => {
      stats.done = true;
      ws.removeAllListeners();
      resolve(stats);
    });

    // Timeout after all messages + grace period
    setTimeout(() => {
      if (!stats.done) {
        stats.done = true;
        ws.close();
      }
    }, nMsgs * msgDelay + 30_000);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Scenarios ─────────────────────────────────────────────────────────────────

async function scenarioFlood(token) {
  console.log(`${C}Scenario: FLOOD — 1 user sending ${N_MSGS} messages, ${MSG_DELAY}ms apart${X}\n`);
  let resolve;
  const start = new Promise(r => { resolve = r; });
  const statsP = runConnection(token, 1, N_MSGS, MSG_DELAY, start);
  resolve(); // start immediately
  return [await statsP];
}

async function scenarioMulti(token) {
  console.log(`${C}Scenario: MULTI — ${N_USERS} users sending ${N_MSGS} messages each, ${MSG_DELAY}ms apart${X}\n`);
  let resolve;
  const start = new Promise(r => { resolve = r; });
  const workers = Array.from({ length: N_USERS }, (_, i) =>
    runConnection(token, i + 1, N_MSGS, MSG_DELAY, start)
  );
  resolve(); // all start together
  return Promise.all(workers);
}

async function scenarioBurst(token) {
  console.log(`${C}Scenario: BURST — ${N_USERS} users connect, pause 3s, then all send ${N_MSGS} msgs simultaneously${X}\n`);
  let resolve;
  const start = new Promise(r => { resolve = r; });
  const workers = Array.from({ length: N_USERS }, (_, i) =>
    runConnection(token, i + 1, N_MSGS, 50, start) // very fast: 50ms per msg
  );
  // Give connections time to establish, then release burst
  await sleep(3000);
  console.log(`${Y}Releasing burst...${X}`);
  resolve();
  return Promise.all(workers);
}

// ── Report ────────────────────────────────────────────────────────────────────

function printReport(allStats) {
  const total = allStats.length;
  const connected = allStats.filter(s => s.connected).length;
  const totalSent = allStats.reduce((a, s) => a + s.messagesSent, 0);
  const totalReceived = allStats.reduce((a, s) => a + s.responsesReceived, 0);
  const rateLimitedConnections = allStats.filter(s => s.rateLimitedAt !== null);
  const firstTrigger = rateLimitedConnections.length > 0
    ? Math.min(...rateLimitedConnections.map(s => s.rateLimitedAt))
    : null;
  const avgConnectMs = Math.round(
    allStats.filter(s => s.connectMs).reduce((a, s) => a + s.connectMs, 0) / connected || 0
  );
  const avgFirstResponseMs = Math.round(
    allStats.filter(s => s.firstResponseMs).reduce((a, s) => a + s.firstResponseMs, 0)
    / allStats.filter(s => s.firstResponseMs).length || 0
  );

  console.log(`\n${B}══════════════════════════════════════════════════${X}`);
  console.log(`${B}  WS RATE LIMITER LOAD TEST — RESULTS${X}`);
  console.log(`${B}══════════════════════════════════════════════════${X}\n`);
  console.log(`  ${B}Scenario:${X}           ${SCENARIO}`);
  console.log(`  ${B}Connections:${X}        ${connected}/${total} established`);
  console.log(`  ${B}Avg connect time:${X}   ${avgConnectMs}ms`);
  console.log(`  ${B}Messages sent:${X}      ${totalSent}`);
  console.log(`  ${B}Responses received:${X} ${totalReceived}`);
  console.log(`  ${B}Avg first response:${X} ${avgFirstResponseMs}ms`);
  console.log('');

  if (rateLimitedConnections.length > 0) {
    console.log(`  ${R}⚠ Rate limit triggered:${X}`);
    console.log(`    ${B}Connections affected:${X} ${rateLimitedConnections.length}/${total}`);
    console.log(`    ${B}First trigger at msg:${X} #${firstTrigger}`);
    for (const s of rateLimitedConnections) {
      console.log(`    Connection ${s.connectionId}: rate-limited at msg #${s.rateLimitedAt} (${s.rateLimitCount}× total)`);
    }
  } else {
    console.log(`  ${G}✅ No rate limiting detected${X}`);
    console.log(`  ${C}(Sent ${totalSent} messages across ${connected} connections without hitting a limit)${X}`);
  }

  console.log(`\n  ${B}Per-connection summary:${X}`);
  for (const s of allStats) {
    const limited = s.rateLimitedAt !== null ? `${R}[RATE-LIMITED @msg#${s.rateLimitedAt}]${X}` : `${G}[OK]${X}`;
    console.log(`    Conn ${String(s.connectionId).padStart(3)}: sent=${s.messagesSent} recv=${s.responsesReceived} err=${s.errors} ${limited}`);
  }

  console.log(`\n${B}══════════════════════════════════════════════════${X}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${B}SUNy WebSocket Rate Limiter Load Test${X}`);
  console.log(`Host: ${WS_HOST}  Users: ${N_USERS}  Msgs: ${N_MSGS}  Delay: ${MSG_DELAY}ms  Scenario: ${SCENARIO}\n`);

  // Obtain token
  let token = CLI_TOKEN;
  if (!token) {
    process.stdout.write(`Logging in as ${CLI_USER}... `);
    try {
      token = await login();
      console.log(`${G}✓${X}`);
    } catch (e) {
      console.error(`${R}✗ ${e.message}${X}`);
      process.exit(1);
    }
  }

  let allStats;
  switch (SCENARIO) {
    case 'multi':  allStats = await scenarioMulti(token);  break;
    case 'burst':  allStats = await scenarioBurst(token);  break;
    case 'flood':
    default:       allStats = await scenarioFlood(token);  break;
  }

  printReport(allStats);
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
