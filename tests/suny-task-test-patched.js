/**
 * SUNy Task Execution Test Suite v1
 *
 * Tests SUNy's REAL ability to use its tools — reading files, editing code,
 * creating files, executing commands, and solving multi-step engineering problems.
 *
 * Unlike the behavioral test suite (which scores response text quality),
 * this suite VERIFIES FILE SYSTEM CHANGES to confirm SUNy actually DID the work.
 *
 * Architecture:
 *   1. Creates a FRESH COPY of the test project in a temp directory
 *   2. Logs in to SUNy (suny.technodel.tech)
 *   3. Runs each task: send prompt → wait for response → verify file system
 *   4. Scores each task PASS/FAIL/PARTIAL based on ACTUAL file system state
 *   5. Each task is self-healing: restores the original file state before retry
 *   6. Produces structured JSON report
 *
 * Usage: node suny-task-test.js
 *
 * Configuration:
 *   - HOST/WS_HOST: target server (default: suny.technodel.tech)
 *   - USERNAME/PASSWORD: test account credentials
 *   - CONCURRENCY: parallel connections (default: 2 — file tasks need isolation)
 *   - TASK_TIMEOUT: max wait per task in ms (default: 120000)
 */

const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Configuration ─────────────────────────────────────────────────────────
const HOST = 'https://suny.technodel.tech';
const WS_HOST = 'wss://suny.technodel.tech';
const USERNAME = 'test';
const PASSWORD = 'test';
const CONCURRENCY = 2;   // file tasks need isolation — 2 at a time
const TASK_TIMEOUT = 120000; // 2 min per task
const NON_ANSWER_RETRY_DELAY = 4000; // ms before retrying a non-answer
const MAX_NON_ANSWER_RETRIES = 1;    // max retries per task on non-answer
const PROJECT_DIR = path.join(__dirname, '..', 'task-exec-test');
const TEMP_DIR = path.join(__dirname, '..', 'task-exec-temp');

// ── ANSI colors ───────────────────────────────────────────────────────────
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

// Non-answer detection patterns
const NON_ANSWER_PATTERNS = [
  'Something unexpected happened',
  "couldn't process that message",
  'still working on your last message',
  'please slow down',
  "You've reached the session",
  "You're out of credits",
  'temporarily unavailable',
  'too many messages',
  'please retry',
  'Please rephrase',
];

// ── Helpers ───────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function copyDir(src, dest) {
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ── Preflight: server health + model availability ─────────────────────────

function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      rejectUnauthorized: false,
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(urlStr, jsonBody, cookies) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(jsonBody);
    const url = new URL(urlStr);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(cookies ? { Cookie: cookies } : {}),
      },
      rejectUnauthorized: false,
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

async function preflight() {
  const result = { ok: true, warnings: [], errors: [] };

  // 1. Server health
  try {
    const r = await httpsGet(`${HOST}/api/health`);
    const health = JSON.parse(r.body);
    if (r.status !== 200 || health.status !== 'ok') {
      result.errors.push(`Health check failed: HTTP ${r.status} — ${r.body.slice(0, 100)}`);
      result.ok = false;
    } else {
      log(`${GREEN}  ✅ Server healthy (uptime ${Math.round(health.uptime)}s, db: ${health.db})${RESET}`);
    }
  } catch (e) {
    result.errors.push(`Server unreachable: ${e.message}`);
    result.ok = false;
  }

  // 2. API keys configured (feature-flags endpoint)
  try {
    const r = await httpsGet(`${HOST}/api/feature-flags`);
    if (r.status === 200) {
      log(`${GREEN}  ✅ Feature flags endpoint reachable${RESET}`);
    }
  } catch {
    result.warnings.push('Could not reach feature-flags endpoint');
  }

  return result;
}

/**
 * Create or fetch the test project on the server pointing to TEMP_DIR.
 * Returns { projectId } or null on failure.
 */
async function registerProject(token) {
  const cookieHeader = `suny_token=${token}`;
  try {
    // List existing projects
    const listRes = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: new URL(HOST).hostname,
        path: '/api/projects',
        method: 'GET',
        headers: { Cookie: cookieHeader },
        rejectUnauthorized: false,
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });

    const projects = JSON.parse(listRes.body);
    const existing = Array.isArray(projects)
      ? projects.find(p => p.local_path === TEMP_DIR || p.name === 'task-exec-test')
      : null;

    if (existing) {
      // Update the path to point to current TEMP_DIR
      await new Promise((resolve, reject) => {
        const data = JSON.stringify({ local_path: TEMP_DIR });
        const req = https.request({
          hostname: new URL(HOST).hostname,
          path: `/api/projects/${existing.id}`,
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Cookie: cookieHeader },
          rejectUnauthorized: false,
        }, (res) => { res.resume(); resolve(null); });
        req.on('error', resolve);
        req.write(data);
        req.end();
      });
      return { projectId: existing.id };
    }

    // Create new project
    const createRes = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ name: 'task-exec-test', local_path: TEMP_DIR });
      const req = https.request({
        hostname: new URL(HOST).hostname,
        path: '/api/projects',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Cookie: cookieHeader },
        rejectUnauthorized: false,
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });

    const created = JSON.parse(createRes.body);
    if (created.id) return { projectId: created.id };
    return null;
  } catch (e) {
    log(`${YELLOW}  ⚠️ Project registration failed: ${e.message} — running without project${RESET}`);
    return null;
  }
}

function login() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ username: USERNAME, password: PASSWORD });
    const req = https.request({
      hostname: 'suny.technodel.tech',
      path: '/api/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      rejectUnauthorized: false,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const cookies = res.headers['set-cookie'] || [];
          const tokenCookie = cookies.find(c => c.startsWith('suny_token='));
          const token = tokenCookie ? tokenCookie.split(';')[0].replace('suny_token=', '') : null;
          if (!token) { reject(new Error('No token: ' + body.substring(0, 200))); return; }
          resolve({ token, ...JSON.parse(body) });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Send a prompt to SUNy and collect the streaming response.
 * Automatically retries once on non-answer with a short delay.
 */
function sendToSUNy(token, prompt, projectId) {
  return sendToSUNyOnce(token, prompt, projectId).then(async (result) => {
    if (result.nonAnswer && MAX_NON_ANSWER_RETRIES > 0) {
      log(`${YELLOW}  ↻ Non-answer detected — retrying in ${NON_ANSWER_RETRY_DELAY / 1000}s...${RESET}`);
      await new Promise(r => setTimeout(r, NON_ANSWER_RETRY_DELAY));
      const retry = await sendToSUNyOnce(token, prompt, projectId);
      retry.retried = true;
      retry.firstNonAnswer = result.response;
      return retry;
    }
    return result;
  });
}

function sendToSUNyOnce(token, prompt, projectId) {
  return new Promise((resolve) => {
    const wsUrl = `${WS_HOST}/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl, { rejectUnauthorized: false });
    let response = '';
    let timedOut = false;
    let nonAnswerDetected = false;
    let finished = false;
    let toolCalls = 0;
    let toolResults = [];
    // Categorize the failure for diagnostics
    let errorCategory = null; // 'server_error' | 'no_tools' | 'timeout' | 'ws_error' | null

    const timeout = setTimeout(() => {
      timedOut = true;
      errorCategory = 'timeout';
      if (!finished) {
        ws.close();
        resolve({ response: response || '[TIMEOUT]', timedOut: true, nonAnswer: false, toolCalls, toolResults, errorCategory });
      }
    }, TASK_TIMEOUT);

    ws.on('open', () => {
      const msg = {
        type: 'chat:message',
        message: prompt,
        sessionId: `task_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        mode: 'fast',
      };
      if (projectId) msg.projectId = projectId;
      ws.send(JSON.stringify(msg));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Accumulate stream chunks
        if (msg.event === 'suny:stream_chunk') {
          response += msg.chunk || '';
        }

        // Track tool calls if reported
        if (msg.event === 'suny:tool_call') {
          toolCalls++;
          toolResults.push({ tool: msg.tool, args: msg.args, result: '(streaming)' });
        }

        // End of stream
        if (msg.event === 'suny:stream_end') {
          finished = true;
          clearTimeout(timeout);
          if (!response && msg.content) response = msg.content;

          const lower = (response || msg.content || '').toLowerCase();
          nonAnswerDetected = NON_ANSWER_PATTERNS.some(p => lower.includes(p.toLowerCase()));

          // Categorize failure type
          if (nonAnswerDetected) {
            errorCategory = toolCalls === 0 ? 'server_error' : 'no_tools';
          } else if (toolCalls === 0) {
            errorCategory = 'no_tools';
          }

          ws.close();
          resolve({ response: response || '[EMPTY]', timedOut: false, nonAnswer: nonAnswerDetected, toolCalls, toolResults, errorCategory });
        }
      } catch { /* non-JSON */ }
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      errorCategory = 'ws_error';
      if (!finished) {
        ws.close();
        resolve({ response: response || '[WS_ERROR]', timedOut: true, nonAnswer: false, toolCalls, toolResults, errorCategory });
      }
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      if (!finished) {
        finished = true;
        const lower = response.toLowerCase();
        nonAnswerDetected = NON_ANSWER_PATTERNS.some(p => lower.includes(p.toLowerCase()));
        resolve({ response: response || '[CLOSED]', timedOut, nonAnswer: nonAnswerDetected, toolCalls, toolResults });
      }
    });
  });
}

/**
 * Create a verification function for each task type.
 * Each returns { pass: boolean, details: string, score: 0|0.5|1 }
 */

const VERIFIERS = {
  /**
   * FILE READING: Verify SUNy read a file and reported its content correctly
   */
  file_read: (task, tempDir) => {
    const filePath = path.join(tempDir, task.file);
    const content = readFile(filePath);
    if (!content) return { pass: false, details: `File not found: ${task.file}`, score: 0 };
    
    const response = task.response || '';
    // Check that key elements from the file appear in SUNy's response
    const checks = task.checks || [];
    let passed = 0;
    for (const check of checks) {
      if (response.includes(check)) passed++;
    }
    const ratio = checks.length > 0 ? passed / checks.length : 0;
    if (ratio >= 0.8) return { pass: true, details: `Read ${task.file} — ${passed}/${checks.length} key elements present`, score: 1 };
    if (ratio >= 0.5) return { pass: false, details: `Partial read of ${task.file} — ${passed}/${checks.length}`, score: 0.5 };
    return { pass: false, details: `Failed to read ${task.file} — only ${passed}/${checks.length} elements found`, score: 0 };
  },

  /**
   * FILE EDITING: Verify SUNy edited a file correctly
   */
  file_edit: (task, tempDir) => {
    const filePath = path.join(tempDir, task.file);
    const content = readFile(filePath);
    if (!content) return { pass: false, details: `File not found: ${task.file}`, score: 0 };

    const expectations = task.expectInFile || [];
    let passed = 0;
    for (const exp of expectations) {
      if (content.includes(exp)) passed++;
    }
    
    const antiExpectations = task.notExpectInFile || [];
    let antiPassed = 0;
    for (const anti of antiExpectations) {
      if (!content.includes(anti)) antiPassed++;
    }

    const ratio = expectations.length > 0 ? passed / expectations.length : 1;
    const antiRatio = antiExpectations.length > 0 ? antiPassed / antiExpectations.length : 1;
    
    if (ratio >= 0.8 && antiRatio >= 0.8) {
      return { pass: true, details: `Fixed ${task.file} — ${passed}/${expectations.length} patterns present, ${antiPassed}/${antiExpectations.length} removed`, score: 1 };
    }
    if (ratio >= 0.5) {
      return { pass: false, details: `Partial fix of ${task.file} — ${passed}/${expectations.length} patterns present`, score: 0.5 };
    }
    return { pass: false, details: `Failed to fix ${task.file} — only ${passed}/${expectations.length} patterns found`, score: 0 };
  },

  /**
   * FILE CREATION: Verify SUNy created a new file with correct content
   */
  file_create: (task, tempDir) => {
    const filePath = path.join(tempDir, task.file);
    if (!fileExists(filePath)) return { pass: false, details: `File not created: ${task.file}`, score: 0 };

    const content = readFile(filePath);
    const expectations = task.expectInFile || [];
    let passed = 0;
    for (const exp of expectations) {
      if (content.includes(exp)) passed++;
    }
    const ratio = expectations.length > 0 ? passed / expectations.length : 1;
    if (ratio >= 0.8) return { pass: true, details: `Created ${task.file} — ${passed}/${expectations.length} patterns correct`, score: 1 };
    if (ratio >= 0.5) return { pass: false, details: `Created ${task.file} but partial — ${passed}/${expectations.length}`, score: 0.5 };
    return { pass: false, details: `Created ${task.file} but content wrong — only ${passed}/${expectations.length}`, score: 0 };
  },

  /**
   * BASH EXECUTION: Verify SUNy ran a command and got correct results
   */
  bash_test_pass: (task, tempDir) => {
    const response = task.response || '';
    // Check if SUNy ran the test and reported results
    const hasTestResults = response.includes('pass') || response.includes('fail') || response.includes('✅') || response.includes('❌');
    
    // Also check if the file was actually fixed (tests now pass)
    const testRunner = path.join(tempDir, 'test-files/run-tests.js');
    if (fileExists(testRunner)) {
      try {
        const proc = require('child_process').spawnSync('node', [testRunner], { cwd: tempDir, timeout: 10000 });
        const output = proc.stdout.toString();
        const passedCount = (output.match(/✅/g) || []).length;
        const failedCount = (output.match(/❌/g) || []).length;
        
        if (failedCount === 0 && passedCount > 0) {
          return { pass: true, details: `Tests pass: ${passedCount} passed, 0 failed`, score: 1 };
        }
        if (failedCount > 0 && failedCount < 3) {
          return { pass: false, details: `Partial fix: ${passedCount} passed, ${failedCount} still failing`, score: 0.5 };
        }
        return { pass: false, details: `Tests still failing: ${passedCount} passed, ${failedCount} failed`, score: 0 };
      } catch (e) {
        return { pass: false, details: `Could not run tests: ${e.message}`, score: 0 };
      }
    }
    
    if (hasTestResults) return { pass: false, details: 'SUNy reported test results but file not verifiable', score: 0.5 };
    return { pass: false, details: 'No test results in response', score: 0 };
  },

  /**
   * BUILD VERIFICATION: Verify SUNy fixed the build script
   */
  bash_build: (task, tempDir) => {
    const buildScript = path.join(tempDir, 'src/build.js');
    const content = readFile(buildScript);
    if (!content) return { pass: false, details: 'build.js not found', score: 0 };

    // Check for fix: wrong key name 'outputs' should be 'output'
    const hasOutputKeyFix = content.includes('config.output') && !content.includes('config.outputs');
    const hasDistDir = content.includes('mkdir') || content.includes('fs.mkdir') || content.includes('existsSync');
    const hasTryCatch = content.includes('try') && content.includes('catch');
    
    let fixed = 0;
    if (hasOutputKeyFix) fixed++;
    if (hasDistDir) fixed++;
    if (hasTryCatch) fixed++;
    
    if (fixed >= 2) return { pass: true, details: `Build script fixed: ${fixed}/3 issues resolved`, score: 1 };
    if (fixed >= 1) return { pass: false, details: `Build script partially fixed: ${fixed}/3`, score: 0.5 };
    return { pass: false, details: 'Build script not fixed', score: 0 };
  },

  /**
   * PYTHON BUG FIX: Verify SUNy fixed the calculator bugs
   */
  python_fix: (task, tempDir) => {
    const filePath = path.join(tempDir, 'python/calculator.py');
    const content = readFile(filePath);
    if (!content) return { pass: false, details: 'calculator.py not found', score: 0 };

    const hasZeroDivCheck = content.includes('ZeroDivisionError') || content.includes('b == 0') || content.includes('if b') || content.includes('== 0');
    
    let fixed = 0;
    if (hasZeroDivCheck) fixed++;
    
    if (fixed >= 1) return { pass: true, details: `Calculator fixed: division by zero handled`, score: 1 };
    return { pass: false, details: 'Division by zero not handled', score: 0 };
  },

  /**
   * MULTI-STEP: Verify SUNy identified multiple bugs
   */
  multi_analysis: (task, tempDir) => {
    const response = task.response || '';
    const bugs = task.bugsToFind || [];
    let found = 0;
    for (const bug of bugs) {
      if (response.toLowerCase().includes(bug.toLowerCase())) found++;
    }
    const ratio = bugs.length > 0 ? found / bugs.length : 0;
    if (ratio >= 0.7) return { pass: true, details: `Found ${found}/${bugs.length} bugs: comprehensive analysis`, score: 1 };
    if (ratio >= 0.4) return { pass: false, details: `Found ${found}/${bugs.length} bugs: partial analysis`, score: 0.5 };
    return { pass: false, details: `Found only ${found}/${bugs.length} bugs: insufficient analysis`, score: 0 };
  },
};

// ── Task Definitions ────────────────────────────────────────────────────

function buildTasks() {
  const T = [];

  // ── CATEGORY 1: FILE READING (3 tasks) ──
  T.push({
    id: 'read_001',
    category: 'file_read',
    title: 'Read main source file and describe it',
    prompt: `Read the file src/index.js from the task-exec-test project and tell me what it does. List all the exported functions.`,
    file: 'src/index.js',
    verifier: 'file_read',
    checks: ['calculateTotal', 'getUserData', 'formatDate', 'processOrder', 'filterItems', 'greetUser'],
    weight: 3,
    setup: () => {},
  });

  T.push({
    id: 'read_002',
    category: 'file_read',
    title: 'Read config file and summarize',
    prompt: `Read src/config.json from the task-exec-test project and tell me what the app configuration looks like. What port does it use? What database?`,
    file: 'src/config.json',
    verifier: 'file_read',
    checks: ['3000', 'localhost', '5432', 'taskexec'],
    weight: 2,
    setup: () => {},
  });

  T.push({
    id: 'read_003',
    category: 'file_read',
    title: 'Read sample data and answer questions',
    prompt: `Read test-files/sample.txt from the task-exec-test project. How many lines does it have? What's on line 8?`,
    file: 'test-files/sample.txt',
    verifier: 'file_read',
    checks: ['10', 'URL', 'https://', 'query=param'],
    weight: 2,
    setup: () => {},
  });

  // ── CATEGORY 2: CODE EDITING (4 tasks) ──
  T.push({
    id: 'edit_001',
    category: 'file_edit',
    title: 'Fix floating point precision bug',
    prompt: `Fix the floating point precision bug in the calculateTotal function in src/index.js of the task-exec-test project. Currently 0.1 + 0.2 returns 0.30000000000000004 instead of 0.3. Use Math.round or toFixed to fix it.`,
    file: 'src/index.js',
    verifier: 'file_edit',
    expectInFile: ['Math.round', '100'],
    notExpectInFile: ['0.1 + 0.2', '00000000000004'],
    weight: 5,
    setup: () => {},
  });

  T.push({
    id: 'edit_002',
    category: 'file_edit',
    title: 'Fix off-by-one error in formatDate',
    prompt: `Fix the off-by-one error in the formatDate function in src/index.js of the task-exec-test project. JavaScript's getMonth() is 0-indexed, so March (month 2) should display as 3, not 2.`,
    file: 'src/index.js',
    verifier: 'file_edit',
    expectInFile: ['getMonth() + 1', 'getMonth()+1'],
    notExpectInFile: ['getMonth()}/${d.getDate'],
    weight: 4,
    setup: () => {},
  });

  T.push({
    id: 'edit_003',
    category: 'file_edit',
    title: 'Fix missing input validation in processOrder',
    prompt: `Add input validation to the processOrder function in src/index.js of the task-exec-test project. It should check that order exists, items is an array, and each item has valid price/quantity before calculating.`,
    file: 'src/index.js',
    verifier: 'file_edit',
    expectInFile: ['if (!order', 'Array.isArray', 'throw'],
    notExpectInFile: ['Cannot read'],
    weight: 4,
    setup: () => {},
  });

  T.push({
    id: 'edit_004',
    category: 'file_edit',
    title: 'Fix filterItems logic error',
    prompt: `Fix the filterItems function in src/index.js of the task-exec-test project. The function should check item.tags.includes(query) properly — tags is an array and includes() should work, but make sure it handles the case where tags is undefined or null.`,
    file: 'src/index.js',
    verifier: 'file_edit',
    expectInFile: ['tags', 'includes'],
    notExpectInFile: ['Cannot read'],
    weight: 3,
    setup: () => {},
  });

  // ── CATEGORY 3: FILE CREATION (2 tasks) ──
  T.push({
    id: 'create_001',
    category: 'file_create',
    title: 'Create validation utility file',
    prompt: `Create a new file src/validation.js in the task-exec-test project with exported functions: isValidEmail(email), isPositiveNumber(n), and isNonEmptyString(s). Each should return true/false and handle edge cases.`,
    file: 'src/validation.js',
    verifier: 'file_create',
    expectInFile: ['isValidEmail', 'isPositiveNumber', 'isNonEmptyString', 'function'],
    weight: 4,
    setup: () => {},
  });

  T.push({
    id: 'create_002',
    category: 'file_create',
    title: 'Create unit test for validation',
    prompt: `Create a new file test-files/validation.test.js in the task-exec-test project that tests the validation functions from src/validation.js (create src/validation.js first if needed). Test at least 3 cases per function including edge cases.`,
    file: 'test-files/validation.test.js',
    verifier: 'file_create',
    expectInFile: ['test', 'expect', 'isValidEmail', 'isPositiveNumber', 'isNonEmptyString'],
    weight: 3,
    setup: () => {},
  });

  // ── CATEGORY 4: BASH/TEST EXECUTION (2 tasks) ──
  T.push({
    id: 'bash_001',
    category: 'bash_exec',
    title: 'Run tests and fix failures',
    prompt: `Run the test suite in the task-exec-test project by executing: node test-files/run-tests.js. Then fix all the failing tests by correcting the source code in src/index.js. Keep fixing until all tests pass.`,
    file: 'test-files/run-tests.js',
    verifier: 'bash_test_pass',
    weight: 5,
    setup: () => {},
  });

  T.push({
    id: 'bash_002',
    category: 'bash_exec',
    title: 'Fix build script errors',
    prompt: `Fix the build script at src/build.js in the task-exec-test project. It has a wrong variable name (config.outputs instead of config.output) and is missing directory creation. Fix both issues.`,
    file: 'src/build.js',
    verifier: 'bash_build',
    weight: 4,
    setup: () => {},
  });

  // ── CATEGORY 5: PYTHON (1 task) ──
  T.push({
    id: 'python_001',
    category: 'python',
    title: 'Fix Python division by zero',
    prompt: `Read python/calculator.py from the task-exec-test project and fix the division by zero bug in the divide function. Add proper error handling.`,
    file: 'python/calculator.py',
    verifier: 'python_fix',
    weight: 3,
    setup: () => {},
  });

  // ── CATEGORY 6: MULTI-STEP ANALYSIS (2 tasks) ──
  T.push({
    id: 'multi_001',
    category: 'multi_analysis',
    title: 'Analyze entire project and identify bugs',
    prompt: `Read ALL source files in the task-exec-test project (src/index.js, src/build.js, python/calculator.py, src/component.jsx) and identify every bug you can find. List them all with file names, line numbers, and explain how to fix each one.`,
    file: null,
    verifier: 'multi_analysis',
    bugsToFind: [
      'floating point', 'off-by-one', 'formatDate', 'missing input validation',
      'processOrder', 'division by zero', 'config.outputs',
      'missing key', 'state mutation', 'dependency array',
    ],
    weight: 5,
    setup: () => {},
  });

  T.push({
    id: 'multi_002',
    category: 'multi_analysis',
    title: 'Security audit of config',
    prompt: `Read src/config.json from the task-exec-test project and identify any security issues. What sensitive information is exposed? What would you recommend fixing?`,
    file: null,
    verifier: 'multi_analysis',
    bugsToFind: ['password', 'api key', 'sk-live', 'secret', 'credentials'],
    weight: 3,
    setup: () => {},
  });

  return T;
}

// ── Main Test Runner ─────────────────────────────────────────────────────

async function runTask(auth, task, tempDir, projectId) {
  log(`${YELLOW}▶ ${task.title}${RESET}`);
  
  // Run setup (restore file state)
  if (task.setup) task.setup();

  // Send prompt to SUNy (with project context if available)
  const result = await sendToSUNy(auth.token, task.prompt, projectId);
  
  // Store response for verification
  task.response = result.response;
  task.rawResult = result;

  // Run verification
  const verifier = VERIFIERS[task.verifier];
  if (!verifier) {
    task.pass = false;
    task.details = `No verifier found: ${task.verifier}`;
    task.score = 0;
  } else {
    const verification = verifier(task, tempDir);
    task.pass = verification.pass;
    task.details = verification.details;
    task.score = verification.score;
    task.toolCalls = result.toolCalls;
    task.nonAnswer = result.nonAnswer;
    task.timedOut = result.timedOut;
    task.errorCategory = result.errorCategory || null;
    task.retried = result.retried || false;
  }

  // Display result
  const icon = task.pass ? '✅' : task.score >= 0.5 ? '⚠️' : '❌';
  const color = task.pass ? GREEN : task.score >= 0.5 ? YELLOW : RED;
  log(`${color}${icon} [${task.pass ? 'PASS' : task.score >= 0.5 ? 'PARTIAL' : 'FAIL'}] ${task.title} — ${task.details}${RESET}`);
  if (task.toolCalls > 0) log(`  ${CYAN}🛠 ${task.toolCalls} tool calls${RESET}`);
  if (task.errorCategory) log(`  ${YELLOW}⚠ Error category: ${task.errorCategory}${RESET}`);
  if (task.retried) log(`  ${YELLOW}↻ Was retried${RESET}`);

  return task;
}

async function main() {
  console.log(`\n${BOLD}${MAGENTA}══════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}${MAGENTA}  SUNy Task Execution Test Suite v2${RESET}`);
  console.log(`${BOLD}${MAGENTA}══════════════════════════════════════════════════${RESET}\n`);
  log(`${CYAN}Host: ${HOST}${RESET}`);
  log(`${CYAN}User: ${USERNAME}${RESET}`);
  log(`${CYAN}Project: ${PROJECT_DIR}${RESET}`);
  log(`${CYAN}Temp: ${TEMP_DIR}${RESET}\n`);

  // Step 0: Preflight — verify server is healthy before wasting 25 tasks
  log(`${BOLD}[0] Preflight diagnostics...${RESET}`);
  const preflight_result = await preflight();
  if (!preflight_result.ok) {
    for (const err of preflight_result.errors) log(`${RED}  ✗ ${err}${RESET}`);
    log(`${RED}❌ Server not healthy — aborting tests.${RESET}`);
    process.exit(1);
  }
  for (const w of preflight_result.warnings) log(`${YELLOW}  ⚠ ${w}${RESET}`);
  log('');

  // Step 1: Login
  log(`${BOLD}[1] Logging in...${RESET}`);
  let auth;
  try {
    auth = await login();
    log(`${GREEN}✅ Logged in as ${auth.username || USERNAME}${RESET}\n`);
  } catch (e) {
    log(`${RED}❌ Login failed: ${e.message}${RESET}`);
    process.exit(1);
  }

  // Step 2: Create fresh temp copy of test project
  log(`${BOLD}[2] Preparing test project...${RESET}`);
  copyDir(PROJECT_DIR, TEMP_DIR);
  log(`${GREEN}✅ Test project ready at ${TEMP_DIR}${RESET}\n`);

  // Step 2b: Register project with server so file tools are available
  log(`${BOLD}[3] Registering test project with server...${RESET}`);
  const projectInfo = await registerProject(auth.token);
  if (projectInfo) {
    log(`${GREEN}✅ Project registered (id=${projectInfo.projectId}) — file tools will be active${RESET}\n`);
  } else {
    log(`${YELLOW}⚠️ Could not register project — tasks requiring file edits will be limited${RESET}\n`);
  }
  const projectId = projectInfo?.projectId ?? null;

  // Step 3: Build and run tasks
  const allTasks = buildTasks();
  log(`${BOLD}[4] Running ${allTasks.length} tasks...${RESET}\n`);

  const results = { tasks: [], summary: {}, projectId, preflightWarnings: preflight_result.warnings };
  const startTime = Date.now();

  // Run sequentially (file isolation)
  for (let i = 0; i < allTasks.length; i++) {
    const task = allTasks[i];
    log(`${CYAN}[${i + 1}/${allTasks.length}]${RESET} `);
    try {
      await runTask(auth, task, TEMP_DIR, projectId);
    } catch (e) {
      log(`${RED}❌ Task crashed: ${e.message}${RESET}`);
      task.pass = false;
      task.details = `Crash: ${e.message}`;
      task.score = 0;
      task.errorCategory = 'crash';
    }
    results.tasks.push(task);
    
    // Periodic save every 5 tasks
    if ((i + 1) % 5 === 0) {
      const partial = summarize(results.tasks);
      fs.writeFileSync('suny-task-results-partial.json', JSON.stringify({ partial, lastTask: i + 1 }, null, 2));
      log(`${CYAN}💾 Partial save at task ${i + 1}${RESET}\n`);
    }
  }

  // Step 4: Generate summary
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const summary = summarize(results.tasks);
  results.summary = summary;
  results.elapsedMinutes = elapsed;

  // Save full results
  fs.writeFileSync('suny-task-results.json', JSON.stringify(results, null, 2));
  log(`${GREEN}💾 Results saved to suny-task-results.json${RESET}\n`);

  // Step 5: Display final report
  printReport(summary, elapsed, results.tasks);

  // Cleanup temp
  try {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function summarize(tasks) {
  const total = tasks.length;
  const passed = tasks.filter(t => t.pass === true).length;
  const partial = tasks.filter(t => !t.pass && t.score >= 0.5).length;
  const failed = tasks.filter(t => !t.pass && t.score < 0.5).length;
  const weightedScore = tasks.reduce((sum, t) => sum + (t.score * t.weight), 0);
  const totalWeight = tasks.reduce((sum, t) => sum + t.weight, 0);
  
  const byCategory = {};
  for (const t of tasks) {
    if (!byCategory[t.category]) byCategory[t.category] = { total: 0, passed: 0, partial: 0, failed: 0, weighted: 0, weight: 0 };
    byCategory[t.category].total++;
    byCategory[t.category].weight += t.weight;
    byCategory[t.category].weighted += t.score * t.weight;
    if (t.pass) byCategory[t.category].passed++;
    else if (t.score >= 0.5) byCategory[t.category].partial++;
    else byCategory[t.category].failed++;
  }

  return {
    total,
    passed,
    partial,
    failed,
    passRate: total > 0 ? (passed / total * 100).toFixed(1) : '0.0',
    weightedScore: totalWeight > 0 ? (weightedScore / totalWeight * 100).toFixed(1) : '0.0',
    byCategory,
  };
}

function printReport(summary, elapsed, tasks) {
  const barLen = 30;
  const pct = parseFloat(summary.weightedScore) / 100;
  const filled = Math.round(barLen * pct);
  const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);

  console.log(`\n${BOLD}${MAGENTA}══════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}${MAGENTA}  FINAL REPORT${RESET}`);
  console.log(`${BOLD}${MAGENTA}══════════════════════════════════════════════════${RESET}\n`);

  console.log(`  ${BOLD}Duration:${RESET} ${elapsed} minutes`);
  console.log(`  ${BOLD}Tasks:${RESET} ${summary.total} total`);
  console.log(`  ${GREEN}  ✅ Passed: ${summary.passed}${RESET}`);
  console.log(`  ${YELLOW}  ⚠️  Partial: ${summary.partial}${RESET}`);
  console.log(`  ${RED}  ❌ Failed: ${summary.failed}${RESET}`);
  console.log(`  ${BOLD}  Pass Rate:${RESET} ${summary.passRate}%`);
  console.log(`  ${BOLD}  Weighted Score:${RESET} ${summary.weightedScore}%`);
  console.log(`  ${BOLD}  Bar:${RESET} [${bar}] ${summary.weightedScore}%\n`);

  // Error category breakdown (helps diagnose root cause)
  if (tasks && tasks.length > 0) {
    const cats = { server_error: 0, no_tools: 0, timeout: 0, ws_error: 0, crash: 0 };
    for (const t of tasks) {
      if (!t.pass && t.errorCategory) {
        cats[t.errorCategory] = (cats[t.errorCategory] || 0) + 1;
      }
    }
    const retriedCount = tasks.filter(t => t.retried).length;
    const anyErrors = Object.values(cats).some(v => v > 0);
    if (anyErrors || retriedCount > 0) {
      console.log(`  ${BOLD}Failure Diagnostics:${RESET}`);
      if (cats.server_error > 0) console.log(`    ${RED}  server_error: ${cats.server_error} (agent loop threw, 0 tool calls — check API keys / provider health)${RESET}`);
      if (cats.no_tools > 0)    console.log(`    ${YELLOW}  no_tools: ${cats.no_tools} (agent ran but made no tool calls — project not registered?)${RESET}`);
      if (cats.timeout > 0)    console.log(`    ${YELLOW}  timeout: ${cats.timeout} (agent timed out — task too complex or slow provider)${RESET}`);
      if (cats.ws_error > 0)   console.log(`    ${RED}  ws_error: ${cats.ws_error} (WebSocket connection failed — server down?)${RESET}`);
      if (cats.crash > 0)      console.log(`    ${RED}  crash: ${cats.crash} (test harness crashed)${RESET}`);
      if (retriedCount > 0)    console.log(`    ${CYAN}  retried: ${retriedCount} tasks were auto-retried on non-answer${RESET}`);
      console.log('');
    }
  }

  console.log(`  ${BOLD}By Category:${RESET}`);
  for (const [cat, stats] of Object.entries(summary.byCategory)) {
    const catPct = stats.weight > 0 ? (stats.weighted / stats.weight * 100).toFixed(1) : '0.0';
    const label = cat.padEnd(20);
    const status = `${'✅'.repeat(stats.passed)}${'⚠️'.repeat(stats.partial)}${'❌'.repeat(stats.failed)}`.padEnd(10);
    console.log(`    ${CYAN}${label}${RESET} ${status} ${catPct}% (${stats.passed}p/${stats.partial}pa/${stats.failed}f)`);
  }

  // Grade
  const grade = parseFloat(summary.weightedScore);
  let letter = 'F';
  if (grade >= 90) letter = 'A';
  else if (grade >= 80) letter = 'B';
  else if (grade >= 70) letter = 'C';
  else if (grade >= 60) letter = 'D';

  console.log(`\n  ${BOLD}Overall Grade:${RESET} ${letter}${grade >= 80 ? ' 🏆' : grade >= 60 ? ' 👍' : ' 💪'}`);
  
  // Recommendations
  if (summary.failed > 0 || summary.partial > 0) {
    console.log(`\n  ${BOLD}Areas to Improve:${RESET}`);
    for (const [cat, stats] of Object.entries(summary.byCategory)) {
      const catPct = stats.weight > 0 ? (stats.weighted / stats.weight * 100).toFixed(1) : '0.0';
      if (parseFloat(catPct) < 70) {
        console.log(`    ${YELLOW}➜ ${cat}: ${catPct}% — ${stats.failed} failed, ${stats.partial} partial${RESET}`);
      }
    }
  }

  console.log(`\n${BOLD}${MAGENTA}══════════════════════════════════════════════════${RESET}\n`);
}

// ── Run ───────────────────────────────────────────────────────────────────
main().catch(e => {
  console.error(`${RED}Fatal: ${e.message}${RESET}`);
  console.error(e.stack);
  process.exit(1);
});
