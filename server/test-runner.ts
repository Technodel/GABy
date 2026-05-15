import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';

interface TestRunner {
  check: string;
  cmd: string;
  args: string[];
}

interface TestResult {
  passed: number;
  failed: number;
  errors: string[]; // internal only — never sent to users
  success: boolean;
}

const TEST_RUNNERS: TestRunner[] = [
  { check: 'scripts.test', cmd: 'npm', args: ['test', '--', '--ci', '--passWithNoTests'] },
  { check: 'scripts.vitest', cmd: 'npx', args: ['vitest', 'run'] },
  { check: 'pytest.ini', cmd: 'python', args: ['-m', 'pytest', '-q'] },
  { check: 'setup.py', cmd: 'python', args: ['-m', 'pytest', '-q'] },
  { check: 'Cargo.toml', cmd: 'cargo', args: ['test'] },
  { check: 'go.mod', cmd: 'go', args: ['test', './...'] },
];

export function detectTestRunner(projectPath: string): TestRunner | null {
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        return TEST_RUNNERS[0];
      }
      if (pkg.scripts?.vitest) {
        return TEST_RUNNERS[1];
      }
    } catch {
      // ignore
    }
  }
  for (const runner of TEST_RUNNERS.slice(2)) {
    if (fs.existsSync(path.join(projectPath, runner.check))) {
      return runner;
    }
  }
  return null;
}

export function runTests(projectPath: string, runner: TestRunner): Promise<TestResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const child = spawn(runner.cmd, runner.args, {
      cwd: projectPath,
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code) => {
      const result = parseTestResults(stdout + stderr, code ?? 1);
      resolve(result);
    });

    child.on('error', (err) => {
      resolve({ passed: 0, failed: 1, errors: [err.message], success: false });
    });

    // Timeout: 5 minutes
    setTimeout(() => {
      child.kill();
      resolve({ passed: 0, failed: 1, errors: ['Test run timed out'], success: false });
    }, 300000);
  });
}

export function parseTestResults(output: string, exitCode: number): TestResult {
  // Jest/Vitest pattern: "Tests: 5 failed, 10 passed"
  const jestMatch = output.match(/Tests?:\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+passed)?/i);
  if (jestMatch) {
    const failed = parseInt(jestMatch[1] || '0', 10);
    const passed = parseInt(jestMatch[2] || '0', 10);
    return { passed, failed, errors: extractErrors(output), success: failed === 0 && exitCode === 0 };
  }

  // Pytest pattern: "5 failed, 10 passed"
  const pytestMatch = output.match(/(\d+)\s+failed.*?(\d+)\s+passed/i) ||
    output.match(/(\d+)\s+passed/i);
  if (pytestMatch) {
    const passed = parseInt(pytestMatch[pytestMatch.length - 1] || '0', 10);
    const failed = parseInt(pytestMatch[1] || '0', 10);
    return { passed, failed, errors: extractErrors(output), success: failed === 0 && exitCode === 0 };
  }

  // Cargo/Go: just use exit code
  if (exitCode === 0) {
    return { passed: 1, failed: 0, errors: [], success: true };
  }

  return { passed: 0, failed: 1, errors: extractErrors(output), success: false };
}

function extractErrors(output: string): string[] {
  const lines = output.split('\n');
  return lines
    .filter(l => l.match(/error|FAIL|failed|assert/i) && l.trim().length > 0)
    .slice(0, 20);
}
