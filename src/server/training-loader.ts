/**
 * training-loader.ts — SUNy Training & Injection Auto-Loader
 *
 * Auto-loads all training/injection/rules/behavior files into SUNy's system
 * prompt so no custom configuration is ever left unused. Closes the gap
 * between what SUNy knows and what SUNy was told to be.
 *
 * What it loads:
 *   1. Injection/training files from project root:
 *      - _SUNY_ENGINE_INJECTION.md (primary)
 *      - Any *training*.md, *instruct*.md, *injection*.md, *behavior*.md
 *   2. Behavioral rules from the DB (extracted by training-scorer, stored
 *      by behavioral-rules, but never injected — until now).
 *
 * Feature flag: ff_training_loader (default enabled)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getAdapter } from './db';
import { getRelevantRules, formatBehavioralRules } from './behavioral-rules';
import { isFeatureEnabled } from './feature-flags';

// ── Config ───────────────────────────────────────────────────────────────────

const INJECTION_FILE_PATTERNS = [
  /^_SUNY_ENGINE_INJECTION\.md$/i,
  /.*training.*\.md$/i,
  /.*instruct.*\.md$/i,
  /.*injection.*\.md$/i,
  /.*behavior.*\.md$/i,
  /.*rules.*\.md$/i,
];

const MAX_INJECTION_BYTES = 32 * 1024; // 32 KB per file

// ── Types ────────────────────────────────────────────────────────────────────

export interface TrainingLoadResult {
  injectionBlocks: string[];
  behavioralBlock: string | null;
  summary: string;
}

// ── Scan for injection files in project root ─────────────────────────────────

function findInjectionFiles(projectRoot: string): string[] {
  const found: string[] = [];

  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const isMatch = INJECTION_FILE_PATTERNS.some(pattern => pattern.test(entry.name));
      if (isMatch) {
        found.push(path.join(projectRoot, entry.name));
      }
    }
  } catch {
    return [];
  }

  // Sort: _SUNY_ENGINE_INJECTION.md first (highest priority), then alphabetically
  found.sort((a, b) => {
    const aIsPrimary = path.basename(a).startsWith('_SUNY_ENGINE_INJECTION');
    const bIsPrimary = path.basename(b).startsWith('_SUNY_ENGINE_INJECTION');
    if (aIsPrimary && !bIsPrimary) return -1;
    if (!aIsPrimary && bIsPrimary) return 1;
    return a.localeCompare(b);
  });

  return found;
}

// ── Load and format injection files ──────────────────────────────────────────

function loadInjectionFiles(filePaths: string[]): { blocks: string[]; loaded: number } {
  const blocks: string[] = [];
  let loaded = 0;

  for (const filePath of filePaths) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const trimmed = raw.slice(0, MAX_INJECTION_BYTES).trim();
      if (!trimmed) continue;

      const fileName = path.basename(filePath);

      // Strip YAML frontmatter if present (--- ... ---)
      const cleanContent = trimmed.replace(/^---[\s\S]*?---\n?/, '').trim();
      if (!cleanContent) continue;

      blocks.push(
        `<training_injection source="${fileName}">`,
        ...cleanContent.split('\n'),
        '</training_injection>',
      );
      loaded++;
      console.log(`[training-loader] Loaded injection: ${fileName} (${cleanContent.length} chars)`);
    } catch (err) {
      console.warn(`[training-loader] Failed to load ${filePath}:`, (err as Error).message);
    }
  }

  return { blocks, loaded };
}

// ── Main loader — call this to get formatted prompt blocks ───────────────────

export async function loadTrainingAndRules(options: {
  userId: number;
  projectRoot?: string;
}): Promise<TrainingLoadResult> {
  const result: TrainingLoadResult = {
    injectionBlocks: [],
    behavioralBlock: null,
    summary: '',
  };

  // 1. Load injection/training files from project root
  if (options.projectRoot && fs.existsSync(options.projectRoot)) {
    const injectionFiles = findInjectionFiles(options.projectRoot);
    if (injectionFiles.length > 0) {
      const { blocks, loaded } = loadInjectionFiles(injectionFiles);
      result.injectionBlocks = blocks;
      console.log(`[training-loader] Scanned ${injectionFiles.length} file(s), loaded ${loaded}`);
    } else {
      console.log('[training-loader] No injection files found in project root');
    }
  }

  // 2. Load behavioral rules from DB (feature-gated)
  if (isFeatureEnabled('ff_behavioral_rules')) {
    try {
      const db = await getAdapter();
      const rules = await getRelevantRules(db, options.userId, { minConfidence: 0.4, limit: 10 });
      if (rules.length > 0) {
        result.behavioralBlock = formatBehavioralRules(rules);
        console.log(`[training-loader] Loaded ${rules.length} behavioral rules for user ${options.userId}`);
      } else {
        console.log('[training-loader] No behavioral rules found for user');
      }
    } catch (err) {
      console.warn('[training-loader] Failed to load behavioral rules:', (err as Error).message);
    }
  } else {
    console.log('[training-loader] ff_behavioral_rules disabled — skipping behavioral rules');
  }

  // Build summary
  const parts: string[] = [];
  if (result.injectionBlocks.length > 0) parts.push(`${result.injectionBlocks.length} injection block(s)`);
  if (result.behavioralBlock) {
    const ruleCount = result.behavioralBlock.match(/\d+/)?.[0] || 'some';
    parts.push(`${ruleCount} behavioral rule(s)`);
  }
  result.summary = parts.length > 0
    ? `Training loaded: ${parts.join(', ')}`
    : 'No training data loaded';

  console.log(`[training-loader] ${result.summary}`);
  return result;
}
