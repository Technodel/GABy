import { describe, it, expect } from 'vitest';
import {
  PROTECTED_FILES,
  isProtectedFile,
  buildProtectedFileMessage,
  scanForCredentials,
  scanShellForCredentials,
  isPathWithinProject,
} from './security-guard';

// â”€â”€â”€ isProtectedFile â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('isProtectedFile', () => {
  it('should return true for .env by basename', () => {
    expect(isProtectedFile('.env')).toBe(true);
  });

  it('should return true for .env at any depth', () => {
    expect(isProtectedFile('src/server/.env')).toBe(true);
    expect(isProtectedFile('deeply/nested/path/.env')).toBe(true);
  });

  it('should return true for docker-compose.yml', () => {
    expect(isProtectedFile('docker-compose.yml')).toBe(true);
    expect(isProtectedFile('config/docker-compose.yml')).toBe(true);
  });

  it('should return false for non-protected files', () => {
    expect(isProtectedFile('src/index.ts')).toBe(false);
    expect(isProtectedFile('README.md')).toBe(false);
    expect(isProtectedFile('package.json')).toBe(false);
  });

  it('should match all entries in PROTECTED_FILES', () => {
    for (const file of PROTECTED_FILES) {
      expect(isProtectedFile(file)).toBe(true);
      expect(isProtectedFile(`some/path/${file}`)).toBe(true);
    }
  });

  it('should handle Windows backslash paths', () => {
    expect(isProtectedFile('src\\.env')).toBe(true);
    expect(isProtectedFile('config\\.gitignore')).toBe(true);
  });
});

// â”€â”€â”€ buildProtectedFileMessage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('buildProtectedFileMessage', () => {
  it('should include the file path in the message', () => {
    const msg = buildProtectedFileMessage('.env');
    expect(msg).toContain('.env');
    expect(msg).toContain('protected');
  });

  it('should mention user confirmation', () => {
    const msg = buildProtectedFileMessage('tsconfig.json');
    expect(msg).toContain('confirmation');
  });
});

// â”€â”€â”€ scanForCredentials â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('scanForCredentials', () => {
  it('should detect API keys in content', () => {
    const result = scanForCredentials('const api_key = "sk-12345678901234567890"');
    expect(result.hasCredentials).toBe(true);
    expect(result.matches[0].pattern).toBe('API key');
  });

  it('should detect passwords', () => {
    const result = scanForCredentials('password = "supersecret123"');
    expect(result.hasCredentials).toBe(true);
    expect(result.matches[0].pattern).toBe('Password');
  });

  it('should detect bearer tokens', () => {
    const result = scanForCredentials('Authorization: bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(result.hasCredentials).toBe(true);
    expect(result.matches[0].pattern).toBe('Bearer token');
  });

  it('should detect private keys', () => {
    const result = scanForCredentials('-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----');
    expect(result.hasCredentials).toBe(true);
    expect(result.matches[0].pattern).toBe('Private key');
  });

  it('should detect MongoDB connection strings', () => {
    const result = scanForCredentials('mongodb+srv://admin:password@cluster.mongodb.net/db');
    expect(result.hasCredentials).toBe(true);
    expect(result.matches[0].pattern).toBe('MongoDB connection string');
  });

  it('should return clean for harmless content', () => {
    const result = scanForCredentials('const x = 42;\nconsole.log("hello world");');
    expect(result.hasCredentials).toBe(false);
    expect(result.matches).toHaveLength(0);
  });

  it('should mask credentials in preview', () => {
    const result = scanForCredentials('api_key = "my-super-secret-key-12345"');
    expect(result.hasCredentials).toBe(true);
    expect(result.matches[0].preview).not.toContain('my-super-secret-key-12345');
    expect(result.matches[0].preview).toContain('***');
  });

  it('should report correct line numbers', () => {
    const content = 'line1\nline2\napi_key = "sk-12345678901234567890"\nline4';
    const result = scanForCredentials(content);
    expect(result.matches[0].line).toBe(3);
  });
});

// â”€â”€â”€ scanShellForCredentials â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('scanShellForCredentials', () => {
  it('should detect cat of .env file', () => {
    const result = scanShellForCredentials('cat .env');
    expect(result.hasCredentials).toBe(true);
  });

  it('should detect echo of env vars with KEY', () => {
    const result = scanShellForCredentials('echo $API_KEY');
    expect(result.hasCredentials).toBe(true);
  });

  it('should detect printenv', () => {
    const result = scanShellForCredentials('printenv');
    expect(result.hasCredentials).toBe(true);
  });

  it('should pass through safe commands', () => {
    const result = scanShellForCredentials('ls -la && npm run build');
    expect(result.hasCredentials).toBe(false);
  });
});

// â”€â”€â”€ isPathWithinProject â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('isPathWithinProject', () => {
  it('should accept files within the project path', () => {
    expect(isPathWithinProject('/project/src/index.ts', '/project')).toBe(true);
    expect(isPathWithinProject('/project/src/deep/nested/file.ts', '/project')).toBe(true);
  });

  it('should reject files outside the project path', () => {
    expect(isPathWithinProject('/other/src/index.ts', '/project')).toBe(false);
  });

  it('should prevent path traversal attacks', () => {
    expect(isPathWithinProject('/project/../../etc/passwd', '/project')).toBe(false);
  });

  it('should accept the project root itself', () => {
    expect(isPathWithinProject('/project', '/project')).toBe(true);
  });

  it('should handle Windows-style paths', () => {
    expect(isPathWithinProject('C:\\project\\src\\file.ts', 'C:\\project')).toBe(true);
    expect(isPathWithinProject('C:\\project\\..\\..\\etc\\passwd', 'C:\\project')).toBe(false);
  });
});
