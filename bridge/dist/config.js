"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readConfig = readConfig;
exports.writeConfig = writeConfig;
exports.updateConfig = updateConfig;
exports.getRegisteredPaths = getRegisteredPaths;
exports.registerPath = registerPath;
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const CONFIG_DIR = path_1.default.join(os_1.default.homedir(), '.suny');
const CONFIG_FILE = path_1.default.join(CONFIG_DIR, 'config.json');
function readConfig() {
    try {
        if (fs_1.default.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs_1.default.readFileSync(CONFIG_FILE, 'utf8'));
        }
    }
    catch {
        // ignore
    }
    return {};
}
function writeConfig(config) {
    if (!fs_1.default.existsSync(CONFIG_DIR)) {
        fs_1.default.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs_1.default.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}
function updateConfig(updates) {
    const current = readConfig();
    writeConfig({ ...current, ...updates });
}
function getRegisteredPaths() {
    return readConfig().registered_paths || [];
}
function registerPath(p) {
    const config = readConfig();
    const paths = new Set(config.registered_paths || []);
    paths.add(path_1.default.resolve(p));
    config.registered_paths = Array.from(paths);
    writeConfig(config);
}
//# sourceMappingURL=config.js.map