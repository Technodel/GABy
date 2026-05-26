/**
 * SUNy Code Conscience â€” Intent-Aware Change Guardian
 *
 * Detects unintended semantic drift between the user's stated intent and
 * what the agent loop actually changed. Uses the TypeScript compiler API
 * to extract type signatures before/after edits and compares them for
 * unexpected contract changes.
 *
 * Integration points:
 *   - Pre-turn: capture type signatures of files the user's message may affect
 *   - Post-turn: re-extract signatures of changed files, compare for drift
 *   - Correction: if drift is detected, emit a structured diff report that
 *     the agent can use to self-correct (fed into the lint loop)
 */

import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface TypeSignature {
  fileName: string;
  exports: ExportSignature[];
  declarations: DeclarationSignature[];
}

export interface ExportSignature {
  name: string;
  kind: string;        // 'function' | 'class' | 'interface' | 'type' | 'variable' | 'const'
  typeText: string;    // The full type as a string
  isExported: boolean;
}

export interface DeclarationSignature {
  name: string;
  kind: string;
  typeText: string;
  line: number;
}

export interface DriftReport {
  hasDrift: boolean;
  files: DriftFileReport[];
  summary: string;
}

export interface DriftFileReport {
  fileName: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  changes: DriftChange[];
}

export interface DriftChange {
  name: string;
  kind: string;
  beforeType: string | null;
  afterType: string | null;
  severity: 'signature_change' | 'added_export' | 'removed_export';
  isIntentional: boolean; // heuristic: set true if the change matches the user's stated intent
}

const INTENT_KEYWORDS: Record<string, string[]> = {
  rename: ['rename', 'renamed', 'rename_export', 'deprecate'],
  remove: ['remove', 'delete', 'drop', 'deprecate'],
  add: ['add', 'new', 'create', 'introduce', 'implement'],
  change_type: ['type', 'interface', 'signature', 'change', 'update', 'modify'],
  internal: ['internal', 'private', 'refactor', 'extract', 'inline', 'move'],
};

// â”€â”€ TypeScript source file analysis â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function extractTypeSignaturesFromSource(filePath: string): TypeSignature | null {
  if (!fs.existsSync(filePath)) return null;

  const sourceText = fs.readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    path.basename(filePath),
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );

  const exports: ExportSignature[] = [];
  const declarations: DeclarationSignature[] = [];

  function getTypeText(node: ts.Node): string {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    return sourceText.slice(start, end);
  }

  function visit(node: ts.Node, depth: number = 0): void {
    if (depth > 20) return; // safety limit

    // Exported declarations
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
       ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
       ts.isEnumDeclaration(node) || ts.isVariableStatement(node)) &&
      node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const kind = ts.isFunctionDeclaration(node) ? 'function'
        : ts.isClassDeclaration(node) ? 'class'
        : ts.isInterfaceDeclaration(node) ? 'interface'
        : ts.isTypeAliasDeclaration(node) ? 'type'
        : ts.isEnumDeclaration(node) ? 'enum'
        : 'variable';

      const name = ts.isVariableStatement(node)
        ? node.declarationList.declarations.map(d => (d.name as ts.Identifier)?.text ?? 'unnamed').join(', ')
        : (node as ts.DeclarationStatement).name?.getText(sourceFile) ?? 'unnamed';

      // For functions, extract just the signature (name + params + return type)
      // For classes, extract just member-level signatures (no method bodies)
      let typeText = getTypeText(node);
      if (ts.isFunctionDeclaration(node)) {
        const sig = node.name?.getText(sourceFile) ?? 'unnamed';
        const params = node.parameters.map(p => {
          const pName = p.name.getText(sourceFile);
          const pType = p.type ? p.type.getText(sourceFile) : 'any';
          return `${pName}: ${pType}`;
        }).join(', ');
        const returnType = node.type ? node.type.getText(sourceFile) : 'void';
        typeText = `(${params}) => ${returnType}`;
      } else if (ts.isClassDeclaration(node)) {
        const memberSigs = node.members.map(m => {
          const mods = m.modifiers?.filter(mod =>
            mod.kind === ts.SyntaxKind.PublicKeyword ||
            mod.kind === ts.SyntaxKind.PrivateKeyword ||
            mod.kind === ts.SyntaxKind.ProtectedKeyword ||
            mod.kind === ts.SyntaxKind.StaticKeyword ||
            mod.kind === ts.SyntaxKind.ReadonlyKeyword
          ).map(mod => mod.getText(sourceFile)).join(' ') ?? '';
          const mName = m.name ? m.name.getText(sourceFile) : 'constructor';
          if (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)) {
            const params = m.parameters.map(p =>
              `${p.name.getText(sourceFile)}: ${p.type ? p.type.getText(sourceFile) : 'any'}`
            ).join(', ');
            const retType = m.type ? m.type.getText(sourceFile) : 'void';
            return `${mods} ${mName}(${params}): ${retType}`.trim();
          } else if (ts.isPropertyDeclaration(m)) {
            const propType = m.type ? m.type.getText(sourceFile) : 'any';
            return `${mods} ${mName}: ${propType}`.trim();
          }
          return '';
        }).filter(Boolean).join('; ');
        typeText = `class { ${memberSigs} }`;
      }

      exports.push({ name, kind, typeText, isExported: true });
    }

    // All top-level declarations
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
        ts.isVariableDeclaration(node)) {
      const kind = ts.isFunctionDeclaration(node) ? 'function'
        : ts.isClassDeclaration(node) ? 'class'
        : ts.isInterfaceDeclaration(node) ? 'interface'
        : ts.isTypeAliasDeclaration(node) ? 'type'
        : 'variable';

      const name = (node as ts.DeclarationStatement).name?.getText(sourceFile)
        ?? ((node as ts.VariableDeclaration).name as ts.Identifier)?.text
        ?? 'unnamed';

      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const typeText = getTypeText(node).split('\n')[0].slice(0, 120);

      declarations.push({ name, kind, typeText, line });
    }

    ts.forEachChild(node, child => visit(child, depth + 1));
  }

  visit(sourceFile, 0);

  return {
    fileName: path.basename(filePath),
    exports,
    declarations,
  };
}

// â”€â”€ Snapshot management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const snapshotCache = new Map<string, Map<string, TypeSignature>>();

/**
 * Capture type signatures of a set of files before the agent makes changes.
 */
export function captureSnapshot(
  label: string,
  filePaths: string[],
): void {
  const snapshot = new Map<string, TypeSignature>();
  for (const fp of filePaths) {
    const sig = extractTypeSignaturesFromSource(fp);
    if (sig) {
      snapshot.set(fp, sig);
    }
  }
  snapshotCache.set(label, snapshot);
}

/**
 * Extract type signatures of a set of files *after* changes have been made,
 * and compare against the pre-change snapshot.
 */
export function detectDrift(
  label: string,
  changedFilePaths: string[],
  userIntent?: string,
): DriftReport | null {
  const before = snapshotCache.get(label);
  if (!before) return null;

  const fileReports: DriftFileReport[] = [];
  let totalChanges = 0;

  for (const fp of changedFilePaths) {
    const afterSig = extractTypeSignaturesFromSource(fp);
    const beforeSig = before.get(fp);

    if (!beforeSig && afterSig) {
      // New file
      fileReports.push({
        fileName: path.basename(fp),
        status: 'added',
        changes: afterSig.exports.map(e => ({
          name: e.name,
          kind: e.kind,
          beforeType: null,
          afterType: e.typeText,
          severity: 'added_export' as const,
          isIntentional: isChangeIntentional(userIntent ?? '', `add ${e.name}`),
        })),
      });
      totalChanges += afterSig.exports.length;
      continue;
    }

    if (beforeSig && !afterSig) {
      fileReports.push({
        fileName: path.basename(fp),
        status: 'removed',
        changes: beforeSig.exports.map(e => ({
          name: e.name,
          kind: e.kind,
          beforeType: e.typeText,
          afterType: null,
          severity: 'removed_export' as const,
          isIntentional: isChangeIntentional(userIntent ?? '', `remove ${e.name}`),
        })),
      });
      totalChanges += beforeSig.exports.length;
      continue;
    }

    if (!beforeSig && !afterSig) continue;

    // Compare exports for signature changes
    const changes: DriftChange[] = [];
    const beforeExports = new Map(beforeSig!.exports.map(e => [e.name, e]));
    const afterExports = new Map(afterSig!.exports.map(e => [e.name, e]));

    // Check removed exports
    for (const [name, e] of beforeExports) {
      if (!afterExports.has(name)) {
        changes.push({
          name,
          kind: e.kind,
          beforeType: e.typeText,
          afterType: null,
          severity: 'removed_export',
          isIntentional: isChangeIntentional(userIntent ?? '', `remove ${name}`),
        });
      }
    }

    // Check added exports
    for (const [name, e] of afterExports) {
      if (!beforeExports.has(name)) {
        changes.push({
          name,
          kind: e.kind,
          beforeType: null,
          afterType: e.typeText,
          severity: 'added_export',
          isIntentional: isChangeIntentional(userIntent ?? '', `add ${name}`),
        });
      }
    }

    // Check signature changes (existing exports with different types)
    for (const [name, beforeE] of beforeExports) {
      const afterE = afterExports.get(name);
      if (afterE && beforeE.typeText !== afterE.typeText) {
        changes.push({
          name,
          kind: beforeE.kind,
          beforeType: beforeE.typeText,
          afterType: afterE.typeText,
          severity: 'signature_change',
          isIntentional: isChangeIntentional(userIntent ?? '', `${name} ${beforeE.typeText} ${afterE.typeText}`),
        });
      }
    }

    if (changes.length > 0) {
      totalChanges += changes.length;
      fileReports.push({
        fileName: path.basename(fp),
        status: 'changed' as const,
        changes,
      });
    }
  }

  if (totalChanges === 0) {
    return { hasDrift: false, files: [], summary: 'No semantic drift detected.' };
  }

  // Build human-readable summary
  const lines: string[] = [];
  for (const fr of fileReports) {
    const intentional = fr.changes.filter(c => c.isIntentional);
    const unintentional = fr.changes.filter(c => !c.isIntentional);
    if (unintentional.length > 0) {
      lines.push(`${fr.fileName} (${fr.status}): ${unintentional.length} unexpected change(s)`);
      for (const c of unintentional) {
        lines.push(`  - ${c.severity}: ${c.name} (${c.kind})`);
      }
    }
    if (intentional.length > 0) {
      lines.push(`${fr.fileName} (${fr.status}): ${intentional.length} expected change(s) â€” consistent with intent`);
    }
  }

  const summary = lines.length > 0
    ? `Change Guardian found ${totalChanges} export change(s):\n${lines.join('\n')}`
    : 'No semantic drift detected.';

  // Clean up snapshot after analysis
  snapshotCache.delete(label);

  return {
    hasDrift: totalChanges > 0,
    files: fileReports,
    summary,
  };
}

// â”€â”€ Intent classification heuristic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function isChangeIntentional(userMessage: string, changeDescription: string): boolean {
  if (!changeDescription || !userMessage) return false;

  const msg = userMessage.toLowerCase();

  // Extract the symbol name from the change description.
  // changeDescription patterns:
  //   "add deleteUser"         â†’ added export
  //   "remove User"          â†’ removed export
  //   "getUser (param) => Ret (param2) => Ret2"  â†’ signature change
  const parts = changeDescription.split(/\s+/);
  const symbolName = parts.length > 0 ? parts[0] : '';

  // Split the symbol name into words (handle camelCase and snake_case)
  const symbolWords = symbolName
    .replace(/([A-Z])/g, ' $1')
    .split(/[_\s]+/)
    .filter(w => w.length > 2)
    .map(w => w.toLowerCase());

  // Check if any component word from the symbol name appears in user's message
  for (const w of symbolWords) {
    if (msg.includes(w)) return true;
  }

  return false;
}

// â”€â”€ Generate system-prompt drift warning â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * If drift is detected, generates compact text that can be injected into the
 * agent loop's correction prompt so the AI can self-correct.
 */
export function formatDriftForCorrection(report: DriftReport): string {
  if (!report.hasDrift) return '';

  const unintentionalChanges = report.files.flatMap(f =>
    f.changes.filter(c => !c.isIntentional)
  );

  if (unintentionalChanges.length === 0) return '';

  const lines: string[] = [
    'âš ï¸ SUNy CODE CONSCIENCE â€” CHANGE GUARDIAN ALERT',
    'The following export changes appear unintentional and may cause drift:',
    '',
  ];

  for (const c of unintentionalChanges) {
    const action = c.severity === 'removed_export' ? 'Removed'
      : c.severity === 'added_export' ? 'Added'
      : 'Changed signature of';
    lines.push(`  - ${action} ${c.kind} \`${c.name}\``);
    if (c.beforeType && c.afterType) {
      lines.push(`    Before: ${c.beforeType}`);
      lines.push(`    After:  ${c.afterType}`);
    }
  }

  lines.push(
    '',
    'If these changes are unintended, please revert them or adjust to preserve',
    'the original contract. If they are intended, acknowledge and proceed.',
  );

  return lines.join('\n');
}

// â”€â”€ Clear snapshot cache (on session end, error, etc.) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function clearSnapshot(label?: string): void {
  if (label) {
    snapshotCache.delete(label);
  } else {
    snapshotCache.clear();
  }
}
