"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SandboxError = void 0;
exports.validatePath = validatePath;
exports.validateCommand = validateCommand;
const path_1 = __importDefault(require("path"));
const config_1 = require("./config");
// Commands that are allowed without special confirmation
const ALLOWED_COMMAND_PREFIXES = [
    'npm', 'npx', 'node', 'python', 'python3', 'pip', 'pip3',
    'git', 'cargo', 'go', 'yarn', 'pnpm', 'bun', 'tsx', 'ts-node',
    'mvn', 'gradle', 'dotnet', 'ruby', 'bundle',
];
class SandboxError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SandboxError';
    }
}
exports.SandboxError = SandboxError;
/**
 * Validate that a given path is inside one of the user's registered project directories.
 * Throws SandboxError if the path is outside registered directories.
 */
function validatePath(targetPath) {
    const resolved = path_1.default.resolve(targetPath);
    const registered = (0, config_1.getRegisteredPaths)();
    if (registered.length === 0) {
        // No paths registered yet — reject all operations
        throw new SandboxError('No project directories registered. Please register a project directory first.');
    }
    const allowed = registered.some(regPath => {
        const resolvedReg = path_1.default.resolve(regPath);
        return resolved === resolvedReg || resolved.startsWith(resolvedReg + path_1.default.sep);
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
function validateCommand(command, requiresConfirmation) {
    if (requiresConfirmation)
        return; // Explicitly approved by server
    const normalizedCmd = command.trim().split(/\s+/)[0].toLowerCase();
    // Handle Windows .cmd/.exe suffixes
    const baseName = path_1.default.basename(normalizedCmd).replace(/\.(cmd|exe|bat)$/i, '');
    const allowed = ALLOWED_COMMAND_PREFIXES.some(prefix => baseName === prefix || baseName.startsWith(prefix));
    if (!allowed) {
        throw new SandboxError(`Command '${baseName}' is not in the allowed command list.`);
    }
}
//# sourceMappingURL=sandbox.js.map