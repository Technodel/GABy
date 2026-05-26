/**
 * Unit tests for SUNy Code Conscience â€” Change Guardian
 *
 * Tests TypeScript signature extraction, snapshot capture/drift detection,
 * and report formatting using temporary test source files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

// Re-import the module each time to get fresh snapshot cache
import {
  captureSnapshot,
  detectDrift,
  formatDriftForCorrection,
  clearSnapshot,
  type DriftReport,
} from './change-guardian';

// â”€â”€ Test file management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface TestFiles {
  dir: string;
  filePaths: string[];
}

function createTestDir(): TestFiles {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'suny-guardian-test-'));
  return { dir, filePaths: [] };
}

function writeSource(dir: string, fileName: string, content: string): string {
  const fullPath = `${dir}/${fileName}`;
  fs.writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

function removeTestDir(files: TestFiles): void {
  // Clean up individual files first
  for (const fp of files.filePaths) {
    try { fs.unlinkSync(fp); } catch { /* ignore */ }
  }
  // Clean up directory
  try { fs.rmdirSync(files.dir); } catch { /* ignore */ }
}

// â”€â”€ Test source code samples â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const ORIGINAL_SERVICE = `
export interface User {
  id: number;
  name: string;
  email: string;
}

export function getUser(id: number): Promise<User> {
  return Promise.resolve({ id, name: 'Test', email: 'test@test.com' });
}

export class UserService {
  private users: User[] = [];

  addUser(user: User): void {
    this.users.push(user);
  }

  findUser(email: string): User | undefined {
    return this.users.find(u => u.email === email);
  }
}

const INTERNAL_CONSTANT = 'secret';
`;

const MODIFIED_SERVICE_SAME_CONTRACT = `
export interface User {
  id: number;
  name: string;
  email: string;
}

export function getUser(id: number): Promise<User> {
  return Promise.resolve({ id, name: 'Updated', email: 'updated@test.com' });
}

export class UserService {
  private users: User[] = [];

  addUser(user: User): void {
    this.users.push(user);
    console.log('User added');
  }

  findUser(email: string): User | undefined {
    return this.users.find(u => u.email === email);
  }
}
`;

const MODIFIED_SERVICE_DRIFTED_CONTRACT = `
export interface User {
  id: number;
  name: string;
  email: string;
  role: string;
}

export function getUser(id: string): Promise<User> {
  return Promise.resolve({ id: 0, name: 'Test', email: 'test@test.com', role: 'user' });
}

export function deleteUser(id: number): Promise<boolean> {
  return Promise.resolve(true);
}
`;

const NEW_FILE_CONTENT = `
export function newFeature(): string {
  return 'brand new';
}
`;

// â”€â”€ Tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Change Guardian â€” no drift when nothing changes', () => {
  let files: TestFiles;

  beforeEach(() => {
    files = createTestDir();
    clearSnapshot();
  });

  afterEach(() => removeTestDir(files));

  it('returns null when no snapshot exists', () => {
    const report = detectDrift('nonexistent', ['/fake/file.ts'], '');
    expect(report).toBeNull();
  });

  it('returns hasDrift=false for unchanged files', () => {
    const fp = writeSource(files.dir, 'service.ts', ORIGINAL_SERVICE);
    files.filePaths.push(fp);

    captureSnapshot('test1', [fp]);
    // Don't change the file â€” same content
    const report = detectDrift('test1', [fp], '');
    expect(report).not.toBeNull();
    expect(report!.hasDrift).toBe(false);
  });
});

describe('Change Guardian â€” signature drift detection', () => {
  let files: TestFiles;

  beforeEach(() => {
    files = createTestDir();
    clearSnapshot();
  });

  afterEach(() => removeTestDir(files));

  it('detects NO drift when internal implementation changes but exports stay same', () => {
    const fp = writeSource(files.dir, 'service.ts', ORIGINAL_SERVICE);
    files.filePaths.push(fp);

    captureSnapshot('test_no_drift', [fp]);

    // Modify file with same exported contracts
    fs.writeFileSync(fp, MODIFIED_SERVICE_SAME_CONTRACT, 'utf-8');

    const report = detectDrift('test_no_drift', [fp], '');
    expect(report).not.toBeNull();
    // No drift: all exports (User, getUser, UserService) have same signatures
    expect(report!.hasDrift).toBe(false);
  });

  it('detects drift when export signatures change', () => {
    const fp = writeSource(files.dir, 'service.ts', ORIGINAL_SERVICE);
    files.filePaths.push(fp);

    captureSnapshot('test_drift', [fp]);

    // Modify with contract-breaking changes
    fs.writeFileSync(fp, MODIFIED_SERVICE_DRIFTED_CONTRACT, 'utf-8');

    const report = detectDrift('test_drift', [fp], '');
    expect(report).not.toBeNull();
    expect(report!.hasDrift).toBe(true);

    // Should detect: User.role added, getUser param changed id: numberâ†’string, deleteUser added
    const allChanges = report!.files.flatMap(f => f.changes);
    expect(allChanges.length).toBeGreaterThanOrEqual(3);

    const signatureChanges = allChanges.filter(c => c.severity === 'signature_change');
    expect(signatureChanges.length).toBeGreaterThanOrEqual(1);

    const addedExports = allChanges.filter(c => c.severity === 'added_export');
    expect(addedExports.length).toBeGreaterThanOrEqual(1);
  });

  it('detects removed exports', () => {
    const fp = writeSource(files.dir, 'service.ts', ORIGINAL_SERVICE);
    files.filePaths.push(fp);

    captureSnapshot('test_remove', [fp]);

    // Remove UserService export
    const removed = ORIGINAL_SERVICE.replace(/export class UserService[\s\S]*?\n}/, '');
    fs.writeFileSync(fp, removed, 'utf-8');

    const report = detectDrift('test_remove', [fp], '');
    expect(report).not.toBeNull();
    expect(report!.hasDrift).toBe(true);

    const removedExports = report!.files.flatMap(f =>
      f.changes.filter(c => c.severity === 'removed_export')
    );
    expect(removedExports.length).toBeGreaterThanOrEqual(1);
    expect(removedExports[0].name).toBe('UserService');
  });

  it('detects added file (new exports)', () => {
    const fp = writeSource(files.dir, 'newfile.ts', NEW_FILE_CONTENT);
    files.filePaths.push(fp);

    // No snapshot for this file â€” it's new
    captureSnapshot('test_added', []);

    const report = detectDrift('test_added', [fp], '');
    expect(report).not.toBeNull();
    // If file wasn't in snapshots, we won't detect it as changed
    // Instead it should be handled gracefully
  });
});

describe('Change Guardian â€” intent classification', () => {
  let files: TestFiles;

  beforeEach(() => {
    files = createTestDir();
    clearSnapshot();
  });

  afterEach(() => removeTestDir(files));

  it('flags changes as intentional when user message mentions them', () => {
    const fp = writeSource(files.dir, 'service.ts', ORIGINAL_SERVICE);
    files.filePaths.push(fp);

    captureSnapshot('intent_test', [fp]);

    fs.writeFileSync(fp, MODIFIED_SERVICE_DRIFTED_CONTRACT, 'utf-8');

    // User intent mentions "add role to user" and "change getUser signature"
    const report = detectDrift(
      'intent_test',
      [fp],
      'Add a role field to the User interface, change getUser to accept string id, and add a deleteUser function',
    );
    expect(report).not.toBeNull();
    expect(report!.hasDrift).toBe(true);

    const unintentional = report!.files.flatMap(f =>
      f.changes.filter(c => !c.isIntentional)
    );
    // UserService is removed in MODIFIED_SERVICE_DRIFTED_CONTRACT but user
    // intent doesn't mention removing it â€” so 1 unintentional (UserService)
    const unintentionalNames = unintentional.map(c => c.name);
    expect(unintentionalNames).toContain('UserService');
    expect(unintentionalNames).not.toContain('getUser');
    expect(unintentionalNames).not.toContain('deleteUser');
  });

  it('flags changes as unintentional when user intent is unrelated', () => {
    const fp = writeSource(files.dir, 'service.ts', ORIGINAL_SERVICE);
    files.filePaths.push(fp);

    captureSnapshot('unintentional_test', [fp]);

    fs.writeFileSync(fp, MODIFIED_SERVICE_DRIFTED_CONTRACT, 'utf-8');

    const report = detectDrift(
      'unintentional_test',
      [fp],
      'Fix a typo in the README file',
    );
    expect(report).not.toBeNull();
    expect(report!.hasDrift).toBe(true);

    const unintentional = report!.files.flatMap(f =>
      f.changes.filter(c => !c.isIntentional)
    );
    // User said "fix a typo in README" â€” none of these changes match
    expect(unintentional.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Change Guardian â€” report formatting', () => {
  it('returns empty string for no drift', () => {
    const report: DriftReport = { hasDrift: false, files: [], summary: 'No drift.' };
    const formatted = formatDriftForCorrection(report);
    expect(formatted).toBe('');
  });

  it('formats unintentional changes with details', () => {
    const report: DriftReport = {
      hasDrift: true,
      files: [{
        fileName: 'service.ts',
        status: 'changed',
        changes: [
          {
            name: 'getUser',
            kind: 'function',
            beforeType: '(id: number) => Promise<User>',
            afterType: '(id: string) => Promise<User>',
            severity: 'signature_change',
            isIntentional: false,
          },
          {
            name: 'deleteUser',
            kind: 'function',
            beforeType: null,
            afterType: '(id: number) => Promise<boolean>',
            severity: 'added_export',
            isIntentional: true,
          },
        ],
      }],
      summary: 'Test summary',
    };

    const formatted = formatDriftForCorrection(report);
    expect(formatted).toContain('CHANGE GUARDIAN ALERT');
    expect(formatted).toContain('Changed signature of');
    expect(formatted).toContain('getUser');
    // Should NOT mention the intentional change (deleteUser)
    expect(formatted).not.toContain('deleteUser');
  });
});
