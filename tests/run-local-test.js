/**
 * Local task test runner — creates user, starts server, runs tests.
 * Usage: node run-local-test.js
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');

const BASE = 'http://localhost:3500';
const WS_BASE = 'ws://localhost:3500';
const TEST_USER = 'testbench';
const TEST_PASS = 'testbench123';
const PROJECT_DIR = path.join(__dirname, 'task-exec-test');
const TEMP_DIR = path.join(__dirname, 'task-exec-temp');

// ── Helpers ────────────────────────────────────────────────────────

function httpPost(url, jsonBody) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(jsonBody);
    const u = new URL(url);
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''),
      method: 'GET',
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── Step 1: Register test user ──────────────────────────────────────

async function registerUser() {
  log('Creating test user...');
  const r = await httpPost(`${BASE}/api/register`, {
    username: TEST_USER,
    password: TEST_PASS,
    display_name: 'Test Bench',
  });
  if (r.status === 200 || r.status === 201) {
    log('User created');
    return true;
  }
  // 409 = already exists (fine)
  if (r.status === 409 || (r.body && r.body.includes('already'))) {
    log('User already exists');
    return true;
  }
  // May fail if registration rate-limited or disabled — try admin create
  log(`Register returned ${r.status}: ${r.body.slice(0, 200)}`);
  return false;
}

// ── Step 2: Login ──────────────────────────────────────────────────

async function login() {
  log('Logging in...');
  const r = await httpPost(`${BASE}/api/login`, { username: TEST_USER, password: TEST_PASS });
  if (r.status !== 200) throw new Error(`Login failed: ${r.status} ${r.body.slice(0, 200)}`);
  const cookies = r.headers['set-cookie'] || [];
  const tokenCookie = cookies.find(c => c.startsWith('suny_token='));
  if (!tokenCookie) throw new Error('No token cookie in response');
  const token = tokenCookie.split(';')[0].replace('suny_token=', '');
  log('Logged in');
  return token;
}

// ── Step 3: Register project ───────────────────────────────────────

async function registerProject(token) {
  log('Registering test project...');
  const cookieHeader = `suny_token=${token}`;

  // Try creating project
  const data = JSON.stringify({ name: 'task-exec-test', local_path: TEMP_DIR });
  const u = new URL(BASE);
  const req = http.request({
    hostname: u.hostname, port: u.port,
    path: '/api/projects',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Cookie: cookieHeader },
  }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      try {
        const created = JSON.parse(body);
        if (created.id) log(`Project registered (id=${created.id})`);
        else log('Project registration returned: ' + body.slice(0, 100));
      } catch {
        log('Project registration: ' + body.slice(0, 100));
      }
    });
  });
  req.on('error', e => log('Project registration error: ' + e.message));
  req.write(data);
  req.end();

  // Give it a moment
  await new Promise(r => setTimeout(r, 1000));
}

// ── Step 4: Run a task via WebSocket ────────────────────────────────

function sendToSUNyOnce(token, prompt, projectId) {
  return new Promise((resolve) => {
    const wsUrl = `${WS_BASE}/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    let response = '';
    let timedOut = false;
    let toolCalls = 0;
    let toolResults = [];
    let finished = false;
    let nonAnswerDetected = false;
    let errorCategory = null;

    const timeout = setTimeout(() => {
      timedOut = true;
      errorCategory = 'timeout';
      if (!finished) {
        ws.close();
        resolve({ response: response || '[TIMEOUT]', timedOut: true, nonAnswer: false, toolCalls, toolResults, errorCategory });
      }
    }, 120000);

    ws.on('open', () => {
      const msg = {
        type: 'chat:message',
        message: prompt,
        sessionId: `local_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        mode: 'fast',
      };
      if (projectId) msg.projectId = projectId;
      ws.send(JSON.stringify(msg));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.event === 'suny:stream_chunk') {
          response += msg.chunk || '';
        }

        if (msg.event === 'suny:tool_call') {
          toolCalls++;
          toolResults.push({ tool: msg.tool, args: msg.args, result: '(streaming)' });
        }

        if (msg.event === 'suny:stream_end') {
          finished = true;
          clearTimeout(timeout);
          if (!response && msg.content) response = msg.content;

          const lower = (response || msg.content || '').toLowerCase();
          const NON_ANSWER_PATTERNS = [
            'something unexpected happened', "couldn't process that message",
            'still working on your last message', 'please slow down',
            "you've reached the session", "you're out of credits",
            'temporarily unavailable', 'too many messages', 'please retry',
          ];
          nonAnswerDetected = NON_ANSWER_PATTERNS.some(p => lower.includes(p.toLowerCase()));

          if (nonAnswerDetected) {
            errorCategory = toolCalls === 0 ? 'server_error' : 'no_tools';
          } else if (toolCalls === 0) {
            errorCategory = 'no_tools';
          }

          ws.close();
          resolve({ response: response || '[EMPTY]', timedOut: false, nonAnswer: nonAnswerDetected, toolCalls, toolResults, errorCategory });
        }
      } catch {}
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      if (!finished) {
        ws.close();
        resolve({ response: response || '[WS_ERROR]', timedOut: true, nonAnswer: false, toolCalls, toolResults, errorCategory: 'ws_error' });
      }
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      if (!finished) {
        finished = true;
        const lower = response.toLowerCase();
        const NON_ANSWER_PATTERNS = [
          'something unexpected happened', "couldn't process that message",
          'still working on your last message', 'please slow down',
          "you've reached the session", "you're out of credits",
          'temporarily unavailable', 'too many messages', 'please retry',
        ];
        nonAnswerDetected = NON_ANSWER_PATTERNS.some(p => lower.includes(p.toLowerCase()));
        resolve({ response: response || '[CLOSED]', timedOut, nonAnswer: nonAnswerDetected, toolCalls, toolResults, errorCategory });
      }
    });
  });
}

// ── Helpers: copy dir, read file ──────────────────────────────────

function copyDir(src, dest) {
  if (fs.existsSync(dest)) { fs.rmSync(dest, { recursive: true, force: true }); }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readFile(p) {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== SUNy Local Task Test Suite ===\n');

  // 0. Health check
  log('Checking server health...');
  try {
    const h = await httpGet(`${BASE}/api/health`);
    log(`Server health: ${h.status}`);
  } catch (e) {
    log(`Server not reachable: ${e.message}`);
    log('Make sure the server is running on port 3500');
    process.exit(1);
  }

  // 1. Register user
  await registerUser();

  // 2. Login to get token
  let token;
  try { token = await login(); }
  catch (e) { log(`Login error: ${e.message}`); process.exit(1); }

  // 3. Copy test project
  log('Preparing test project...');
  copyDir(PROJECT_DIR, TEMP_DIR);
  log('Test project ready');

  // 4. Register project
  await registerProject(token);

  // 5. Run a few key tasks
  const tasks = [
    {
      id: 'read_001',
      title: 'Read main source file',
      prompt: 'Read the file src/index.js from the task-exec-test project and tell me what it does. List all the exported functions.',
      file: 'src/index.js',
      checks: ['calculateTotal', 'getUserData', 'formatDate', 'processOrder', 'filterItems', 'greetUser'],
      weight: 3,
    },
    {
      id: 'edit_001',
      title: 'Fix floating point precision bug',
      prompt: 'Fix the floating point precision bug in the calculateTotal function in src/index.js of the task-exec-test project. Currently 0.1 + 0.2 returns 0.30000000000000004 instead of 0.3. Use Math.round or toFixed to fix it.',
      file: 'src/index.js',
      expectInFile: ['Math.round', '100'],
      notExpectInFile: ['0.1 + 0.2', '00000000000004'],
      weight: 5,
    },
    {
      id: 'create_001',
      title: 'Create validation utility file',
      prompt: 'Create a new file src/validation.js in the task-exec-test project with exported functions: isValidEmail(email), isPositiveNumber(n), and isNonEmptyString(s). Each should return true/false and handle edge cases.',
      file: 'src/validation.js',
      expectInFile: ['isValidEmail', 'isPositiveNumber', 'isNonEmptyString', 'function'],
      weight: 4,
    },
    {
      id: 'bash_001',
      title: 'Run tests and fix failures',
      prompt: 'Run the test suite in the task-exec-test project by executing: node test-files/run-tests.js. Then fix all the failing tests by correcting the source code in src/index.js. Keep fixing until all tests pass.',
      file: 'test-files/run-tests.js',
      weight: 5,
    },
  ];

  let passed = 0;
  let partial = 0;
  let failed = 0;
  let totalToolCalls = 0;

  for (const task of tasks) {
    log(`\n▶ ${task.title}`);
    
    // Re-copy project for clean state (for edit/create tasks)
    if (task.id !== 'read_001') {
      copyDir(PROJECT_DIR, TEMP_DIR);
    }

    const result = await sendToSUNyOnce(token, task.prompt, 1);
    task.response = result.response;
    task.toolCalls = result.toolCalls;
    task.nonAnswer = result.nonAnswer;
    task.errorCategory = result.errorCategory;
    totalToolCalls += result.toolCalls;

    log(`  Tool calls: ${result.toolCalls}`);
    
    if (result.toolCalls > 0) log(`  ✅ Tools used!`);
    if (result.nonAnswer) log(`  ⚠️ Non-answer detected: ${result.response.slice(0, 100)}`);
    if (result.errorCategory) log(`  Error: ${result.errorCategory}`);

    // Verify
    const filePath = task.file ? path.join(TEMP_DIR, task.file) : null;
    if (task.checks && filePath && fileExists(filePath)) {
      const content = readFile(filePath);
      const checks = task.checks.filter(c => content.includes(c));
      const pass = checks.length / task.checks.length;
      log(`  Checks: ${checks.length}/${task.checks.length} (${(pass*100).toFixed(0)}%)`);
      if (pass >= 0.8) { passed++; log(`  ✅ PASS`); }
      else if (pass >= 0.5) { partial++; log(`  ⚠️ PARTIAL`); }
      else { failed++; log(`  ❌ FAIL`); }
    } else if (task.expectInFile && filePath && fileExists(filePath)) {
      const content = readFile(filePath);
      const found = task.expectInFile.filter(c => content.includes(c));
      const antiPass = task.notExpectInFile ? task.notExpectInFile.filter(c => !content.includes(c)).length : task.notExpectInFile.length;
      const pass = found.length / task.expectInFile.length;
      log(`  Expected patterns: ${found.length}/${task.expectInFile.length} (${(pass*100).toFixed(0)}%)`);
      if (pass >= 0.8 && antiPass >= 0.8) { passed++; log(`  ✅ PASS`); }
      else if (pass >= 0.5) { partial++; log(`  ⚠️ PARTIAL`); }
      else { failed++; log(`  ❌ FAIL`); }
    } else if (task.id === 'bash_001') {
      // Check if tests passed
      const testRunner = path.join(TEMP_DIR, 'test-files/run-tests.js');
      if (fileExists(testRunner)) {
        const cp = require('child_process');
        const proc = cp.spawnSync('node', [testRunner], { cwd: TEMP_DIR, timeout: 10000 });
        const output = proc.stdout.toString();
        const passedTests = (output.match(/✅/g) || []).length;
        const failedTests = (output.match(/❌/g) || []).length;
        log(`  Tests: ${passedTests} passed, ${failedTests} failed`);
        if (failedTests === 0 && passedTests > 0) { passed++; log(`  ✅ PASS`); }
        else if (failedTests < 3) { partial++; log(`  ⚠️ PARTIAL`); }
        else { failed++; log(`  ❌ FAIL`); }
      } else {
        log(`  ⚠️ No test runner found — checking response`);
        // Fallback: check if response mentions pass/fail
        if (result.response.includes('pass') || result.response.includes('✅')) {
          partial++; log(`  ⚠️ PARTIAL (response mentions passing)`);
        } else {
          failed++; log(`  ❌ FAIL`);
        }
      }
    } else {
      log(`  ❌ File ${task.file} not found or no checks defined`);
      failed++;
    }
  }

  // Summary
  const total = tasks.length;
  const passRate = (passed / total * 100).toFixed(1);
  console.log(`\n═══════════════════════════════════`);
  console.log(`  Results: ${passed}✅ / ${partial}⚠️ / ${failed}❌`);
  console.log(`  Pass rate: ${passRate}%`);
  console.log(`  Total tool calls: ${totalToolCalls}`);
  console.log(`  Average tool calls/task: ${(totalToolCalls / total).toFixed(1)}`);
  console.log(`─────────────────────────────────`);

  // Cleanup
  try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch {}

  if (passed > 0 || partial > 0) {
    console.log(`\n  ${totalToolCalls > 0 ? '✅ FIX CONFIRMED: Tools are being called' : '❌ Still no tool calls'}`);
    if (passRate >= 50) console.log(`  🎉 Pass rate ${passRate}% — fix is working!`);
  }
  console.log(``);
}

main().catch(e => { console.error('Fatal:', e.message, e.stack); process.exit(1); });
