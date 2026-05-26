/**
 * Per-project rules (.suny-rules)
 *
 * If a project root contains a `.suny-rules` file, its content is injected into
 * every system prompt for that project â€” just like Windsurf's .windsurfrules.
 *
 * The file is plain text / markdown. Max 8 KB to prevent abuse.
 */

import * as fs from 'fs';
import * as path from 'path';

const RULES_FILENAME = '.suny-rules';
const MAX_RULES_BYTES = 8 * 1024; // 8 KB

export function loadProjectRules(projectPath: string): string | null {
  try {
    const rulesPath = path.join(projectPath, RULES_FILENAME);
    if (!fs.existsSync(rulesPath)) return null;
    const raw = fs.readFileSync(rulesPath, 'utf8');
    const trimmed = raw.slice(0, MAX_RULES_BYTES).trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

export function saveProjectRules(projectPath: string, content: string): void {
  const rulesPath = path.join(projectPath, RULES_FILENAME);
  fs.writeFileSync(rulesPath, content.slice(0, MAX_RULES_BYTES), 'utf8');
}

export function deleteProjectRules(projectPath: string): void {
  const rulesPath = path.join(projectPath, RULES_FILENAME);
  if (fs.existsSync(rulesPath)) fs.unlinkSync(rulesPath);
}

export const RULES_SYSTEM_SECTION = (rules: string) => `
=== PROJECT RULES ===
The following rules were set by the project owner. Follow them precisely and persistently.
${rules}
=== END PROJECT RULES ===`.trim();
