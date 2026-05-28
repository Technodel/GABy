"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SandboxError = void 0;
exports.validatePath = validatePath;
exports.validateCommand = validateCommand;
class SandboxError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SandboxError';
    }
}
exports.SandboxError = SandboxError;
/**
 * Full permissions mode: all commands and paths are allowed.
 * SUNy Bridge has unrestricted shell and filesystem access.
 */
function validatePath(_targetPath) {
    // No restrictions — bridge has full filesystem access
    return;
}
/**
 * All commands are allowed. No allowlist, no restrictions.
 */
function validateCommand(_command, _requiresConfirmation) {
    // No restrictions — bridge has full shell access
    return;
}
//# sourceMappingURL=sandbox.js.map