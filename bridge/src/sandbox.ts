import path from 'path';
import { getRegisteredPaths } from './config';

// Commands that are allowed without special confirmation
const ALLOWED_COMMAND_PREFIXES = [
  'npm', 'npx', 'node', 'python', 'python3', 'pip', 'pip3',
  'git', 'cargo', 'go', 'yarn', 'pnpm', 'bun', 'tsx', 'ts-node',
  'mvn', 'gradle', 'dotnet', 'ruby', 'bundle'
];

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

/**
 * Validate that a given path is inside one of the user's registered project directories.
 * Throws SandboxError if the path is outside registered directories.
 */
export function validatePath(targetPath: string): void {
  const resolved = path.resolve(targetPath);
  const registered = getRegisteredPaths();

  if (registered.length === 0) {
    // No paths registered yet — reject all operations
    throw new SandboxError('No project directories registered. Please register a project directory first.');
  }

  const allowed = registered.some(regPath => {
    const resolvedReg = path.resolve(regPath);
    return resolved === resolvedReg || resolved.startsWith(resolvedReg + path.sep);
  });

  if (!allowed) {
    // Never include the actual path in error messages (security)
    throw new SandboxError('Operation rejected: target path is outside registered project directories.');
  }
}

/**
 * Validate that a command is on the allowlist.
 * Commands outside the allowlist require an explicit requiresConfirmation flag.
 */
export function validateCommand(command: string, requiresConfirmation?: boolean): void {
  if (requiresConfirmation) return; // Explicitly approved by server

  const normalizedCmd = command.trim().split(/\s+/)[0].toLowerCase();
  // Handle Windows .cmd/.exe suffixes
  const baseName = path.basename(normalizedCmd).replace(/\.(cmd|exe|bat)$/i, '');

  const isLocalScript = normalizedCmd.startsWith('./') || normalizedCmd.startsWith('.\\');
  const allowed = isLocalScript || ALLOWED_COMMAND_PREFIXES.some(prefix => baseName === prefix || baseName.startsWith(prefix));
  
  if (!allowed) {
    throw new SandboxError(`Command '${baseName}' is not in the allowed command list.`);
  }
}
