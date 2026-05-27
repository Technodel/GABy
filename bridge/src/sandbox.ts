export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

/**
 * Full permissions mode: all commands and paths are allowed.
 * SUNy Bridge has unrestricted shell and filesystem access.
 */
export function validatePath(_targetPath: string): void {
  // No restrictions — bridge has full filesystem access
  return;
}

/**
 * All commands are allowed. No allowlist, no restrictions.
 */
export function validateCommand(_command: string, _requiresConfirmation?: boolean): void {
  // No restrictions — bridge has full shell access
  return;
}
