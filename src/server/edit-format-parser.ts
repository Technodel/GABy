/**
 * Edit Format Parser â€” Aider-compatible text-based edit formats
 *
 * Supported formats:
 *   diff     â€” Aider search/replace blocks
 *   whole    â€” fenced code blocks (full file rewrites)
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ApplyResult {
  file: string;
  applied: boolean;
  error?: string;
}

// â”€â”€ DIFF FORMAT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// The model outputs one or more blocks like:
//   path/to/file.ts
//   <<<<<<< SEARCH
//   old content
//   =======
//   new content
//   >>>>>>> REPLACE
//
// We parse all blocks and apply them to the real filesystem.

export function applyDiffFormat(text: string, workingDir: string): ApplyResult[] {
  const results: ApplyResult[] = [];
  // Regex: optional filename before the SEARCH fence, then the block
  const blockRe =
    /^([^\n<>]*?)\s*\n?<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE/gm;

  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(text)) !== null) {
    const rawFile = match[1].trim();
    const searchText = match[2];
    const replaceText = match[3];

    if (!rawFile) {
      results.push({ file: '(unknown)', applied: false, error: 'No filename found before SEARCH block' });
      continue;
    }

    const absPath = path.isAbsolute(rawFile) ? rawFile : path.join(workingDir, rawFile);

    try {
      if (!fs.existsSync(absPath)) {
        results.push({ file: rawFile, applied: false, error: `File not found: ${absPath}` });
        continue;
      }
      const original = fs.readFileSync(absPath, 'utf8');
      if (!original.includes(searchText)) {
        // Try normalising line endings
        const normalOrig = original.replace(/\r\n/g, '\n');
        const normalSearch = searchText.replace(/\r\n/g, '\n');
        if (!normalOrig.includes(normalSearch)) {
          results.push({ file: rawFile, applied: false, error: 'SEARCH block not found in file' });
          continue;
        }
        const updated = normalOrig.replace(normalSearch, replaceText.replace(/\r\n/g, '\n'));
        fs.writeFileSync(absPath, updated, 'utf8');
      } else {
        const updated = original.replace(searchText, replaceText);
        fs.writeFileSync(absPath, updated, 'utf8');
      }
      results.push({ file: rawFile, applied: true });
    } catch (err) {
      results.push({ file: rawFile, applied: false, error: (err as Error).message });
    }
  }

  return results;
}

// â”€â”€ WHOLE FORMAT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// The model outputs fenced code blocks preceded by a filename, e.g.:
//   src/app.ts
//   ```typescript
//   ...full file content...
//   ```
//
// We write the entire content to the file (creating it if it doesn't exist).

export function applyWholeFormat(text: string, workingDir: string): ApplyResult[] {
  const results: ApplyResult[] = [];
  // Matches: optional filename line, then a fenced code block
  const blockRe = /^([^\n`]*?)\s*\n```[a-zA-Z0-9]*\n([\s\S]*?)```/gm;

  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(text)) !== null) {
    const rawFile = match[1].trim();
    const content = match[2];

    if (!rawFile || !rawFile.includes('.')) {
      // Skip blocks without a recognisable filename
      continue;
    }

    const absPath = path.isAbsolute(rawFile) ? rawFile : path.join(workingDir, rawFile);

    try {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, 'utf8');
      results.push({ file: rawFile, applied: true });
    } catch (err) {
      results.push({ file: rawFile, applied: false, error: (err as Error).message });
    }
  }

  return results;
}

// â”€â”€ System prompt injections â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const DIFF_FORMAT_INSTRUCTIONS = `
=== EDIT FORMAT: SEARCH/REPLACE ===
To edit files, output one or more blocks in this exact format:

path/to/file.ext
<<<<<<< SEARCH
[exact content to find â€” must match the file verbatim]
=======
[new content to replace it with]
>>>>>>> REPLACE

Rules:
- The filename line must be the line IMMEDIATELY before <<<<<<< SEARCH.
- The SEARCH section must match the existing file content character-for-character (including indentation).
- You can include multiple SEARCH/REPLACE blocks for different files or different sections.
- To create a new file, use an empty SEARCH section.
- Do NOT include any explanation between the filename and <<<<<<< SEARCH.
`.trim();

export const WHOLE_FORMAT_INSTRUCTIONS = `
=== EDIT FORMAT: WHOLE FILE ===
To edit or create files, output the complete new file content in a fenced code block.
Place the relative file path on the line IMMEDIATELY before the fence:

path/to/file.ext
\`\`\`language
[complete file content]
\`\`\`

Rules:
- Always include the full file content â€” not just the changed parts.
- Output one block per file.
- Use the correct language tag (ts, tsx, py, js, etc.).
`.trim();

export const ARCHITECT_PLAN_INSTRUCTIONS = `
=== ARCHITECT MODE: PLANNING PHASE ===
You are the Architect. Think carefully about the request and produce a detailed plan:
- Which files need to be created or modified?
- What is the exact change needed in each file?
- Are there any edge cases or risks?

Do NOT write actual code yet â€” just the plan. Be specific about file paths and function names.
`.trim();
