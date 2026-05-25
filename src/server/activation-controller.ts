/**
 * activation-controller.ts — Composable AI Behavior Profiles
 *
 * Inspired by ntkmirror's activation-space controllers (leochlon/ntkmirror),
 * this module replaces raw verbatim memory text injection with composable
 * "behavior profiles" that are weighted, combined, and decoded into concise
 * behavioral instructions.
 *
 * ── How it works ──
 * In ntkmirror, each controller scales model hidden states:
 *   h' = exp(s) * h  (scale activation by logit score)
 * Multiple controllers compose via log-space addition.
 *
 * For SUNy (API-based LLMs via Vercel AI SDK), we translate this to
 * prompt-space: each behavior source (interaction memory, behavioral rules,
 * project blueprint, active skills) produces a profile with a trigram vector
 * representation. Profiles are composed via weighted combination, and the
 * result is decoded into a compact natural-language instruction block.
 *
 * ── Composability ──
 * Profiles from different sources are merged by importance weight:
 *   composed = sum(exp(weight_i * 3) * vector_i) / sum(exp(weight_i * 3))
 *
 * This gives stronger signals (higher weight) exponentially more influence
 * while weaker signals still contribute meaningfully — exactly like ntkmirror's
 * log-space composition.
 */

import { textToVector, cosineSimilarity } from './vectors';

const PROFILE_DIMS = 2000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BehaviorProfile {
  /** Unique identifier (source_type + hash) */
  id: string;
  /** Source type */
  source: 'memory' | 'rule' | 'project' | 'skill';
  /** Importance weight (0..1) — controls influence in composition */
  weight: number;
  /** Trigram vector encoding the behavioral essence */
  vector: Float64Array;
  /** Human-readable label */
  label: string;
  /** Decoded instruction — what SUNy should do */
  instruction: string;
  /** Context category for grouping (e.g., "when editing files", "general") */
  context: string;
  /** Number of sub-items this profile represents */
  itemCount: number;
}

export interface ComposedProfile {
  /** The combined vector */
  composedVector: Float64Array;
  /** Individual profiles that contributed */
  contributors: BehaviorProfile[];
  /** Decoded instruction block for prompt injection */
  instructionBlock: string;
  /** Total number of profiles composed */
  count: number;
  /** Average similarity between profiles (diversity metric, 0..1) */
  coherenceScore: number;
}

// ── Profile sources ───────────────────────────────────────────────────────────

/** Profile source priorities for conflict resolution */
const SOURCE_WEIGHTS: Record<BehaviorProfile['source'], number> = {
  memory: 0.5,   // past interactions — moderately important
  rule:   0.8,   // behavioral rules — highly important (explicit lessons)
  project: 0.7,  // project blueprint/guide — important context
  skill:  0.4,   // active skills — lighter touch
};

/**
 * Generate a behavior profile from interaction memories.
 * Encodes the collective "experience" of past Q&A pairs.
 */
export function profileFromMemory(
  interactions: Array<{ userMessage: string; aiResponse: string; score: number }>,
  opts?: { weight?: number },
): BehaviorProfile | null {
  if (interactions.length === 0) return null;

  // Combine all interaction text into one signal
  const combinedText = interactions
    .map((m, i) => {
      const prefix = i === 0 ? 'Based on past experience:' : 'Also learned:';
      return `${prefix} User asked about "${m.userMessage.slice(0, 100)}". The correct approach was: ${m.aiResponse.slice(0, 200)}`;
    })
    .join('\n\n');

  // Weight reflects avg similarity score of retrieved memories
  const avgScore = interactions.reduce((s, m) => s + m.score, 0) / interactions.length;
  const weight = opts?.weight ?? Math.min(0.7, avgScore * 0.8);

  // Extract behavioral essence — what SUNy should do based on this memory
  const essence = interactions.length === 1
    ? `Refer to a similar past interaction where the user asked about a related topic. Apply the same successful approach.`
    : `${interactions.length} similar past interactions suggest a consistent approach for this kind of request. Follow established patterns that worked before.`;

  const vector = textToVector(combinedText, PROFILE_DIMS);

  return {
    id: `mem_${Date.now()}_${interactions.length}`,
    source: 'memory',
    weight: Math.max(0.1, Math.min(1.0, weight)),
    vector,
    label: `Experience: ${interactions.length} similar interaction(s)`,
    instruction: essence,
    context: interactions.some(i => i.userMessage.length > 50) ? 'complex tasks' : 'general',
    itemCount: interactions.length,
  };
}

/**
 * Generate a behavior profile from behavioral rules.
 * Converts explicit lessons (wins/mistakes) into composed guidance.
 */
export function profileFromRules(
  rules: Array<{
    category: string;
    ruleText: string;
    triggerContext: string;
    confidence: number;
  }>,
  opts?: { weight?: number },
): BehaviorProfile | null {
  if (rules.length === 0) return null;

  // Separate wins and mistakes
  const wins = rules.filter(r => r.category === 'win');
  const mistakes = rules.filter(r => r.category === 'mistake');

  // Build concise instruction text from rules
  const winLines = wins.map(r => `  ✓ ${r.ruleText}`);
  const mistakeLines = mistakes.map(r => `  ✗ ${r.ruleText}`);

  const parts: string[] = [];
  if (winLines.length > 0) {
    parts.push(`[Learned behaviors to repeat (${winLines.length} rules)]`);
    parts.push(...winLines);
  }
  if (mistakeLines.length > 0) {
    parts.push(`[Mistakes to avoid (${mistakeLines.length} rules)]`);
    parts.push(...mistakeLines);
  }

  const instruction = parts.join('\n');

  // Group rules by context for vector encoding
  const contextGroups = new Map<string, string[]>();
  for (const r of rules) {
    const ctx = r.triggerContext || 'general';
    if (!contextGroups.has(ctx)) contextGroups.set(ctx, []);
    contextGroups.get(ctx)!.push(r.ruleText);
  }

  // Encode all rules as one vector
  const combinedText = rules.map(r =>
    `[${r.category}] ${r.triggerContext}: ${r.ruleText}`
  ).join('\n');

  const vector = textToVector(combinedText, PROFILE_DIMS);

  // Weight based on avg confidence
  const avgConfidence = rules.reduce((s, r) => s + r.confidence, 0) / rules.length;
  const weight = opts?.weight ?? SOURCE_WEIGHTS.rule * Math.min(1.0, avgConfidence * 1.2);

  return {
    id: `rule_${Date.now()}_${rules.length}`,
    source: 'rule',
    weight: Math.max(0.1, Math.min(1.0, weight)),
    vector,
    label: `Behavioral: ${rules.length} rule(s) (${wins.length} wins, ${mistakes.length} mistakes)`,
    instruction,
    context: rules.length > 0 ? rules[0].triggerContext : 'general',
    itemCount: rules.length,
  };
}

/**
 * Generate a behavior profile from project context (blueprint/guide text).
 */
export function profileFromProject(
  projectText: string,
  opts?: { weight?: number; label?: string },
): BehaviorProfile | null {
  if (!projectText || projectText.length < 20) return null;

  const vector = textToVector(projectText, PROFILE_DIMS);

  // Extract key directive from project text
  const firstLine = projectText.split('\n')[0]?.trim() || '';
  const instruction = `Project context: ${firstLine.slice(0, 120)}`;

  return {
    id: `proj_${Date.now()}`,
    source: 'project',
    weight: opts?.weight ?? SOURCE_WEIGHTS.project,
    vector,
    label: opts?.label ?? 'Project blueprint',
    instruction,
    context: 'project context',
    itemCount: 1,
  };
}

/**
 * Generate a behavior profile from active skills.
 */
export function profileFromSkills(
  skills: Array<{ name: string; description: string }>,
  opts?: { weight?: number },
): BehaviorProfile | null {
  if (skills.length === 0) return null;

  const combinedText = skills.map(s =>
    `[Skill: ${s.name}] ${s.description}`
  ).join('\n');

  const vector = textToVector(combinedText, PROFILE_DIMS);

  const skillNames = skills.map(s => s.name).join(', ');
  const instruction = `Active skills for this task: ${skillNames}. Follow their methodology.`;

  return {
    id: `skill_${Date.now()}_${skills.length}`,
    source: 'skill',
    weight: opts?.weight ?? SOURCE_WEIGHTS.skill,
    vector,
    label: `Skills: ${skills.length} active (${skillNames.slice(0, 60)}...)`,
    instruction,
    context: 'general',
    itemCount: skills.length,
  };
}

// ── Composition ───────────────────────────────────────────────────────────────

/**
 * Compose multiple behavior profiles into a single profile.
 *
 * Uses ntkmirror-inspired weighted combination:
 *   composed = sum(exp(weight_i * AMPLIFY) * vector_i) / sum(exp(weight_i * AMPLIFY))
 *
 * The AMPLIFY factor (3.0) creates exponential separation — a profile with
 * weight 0.8 has ~e^(2.4) ≈ 11x more influence than one with weight 0.1
 * (e^(0.3) ≈ 1.35), mirroring how ntkmirror uses logit scores in activation space.
 */
export function composeProfiles(profiles: BehaviorProfile[]): ComposedProfile | null {
  if (profiles.length === 0) return null;

  const AMPLIFY = 3.0;

  // Compute softmax-style weights
  const rawWeights = profiles.map(p => Math.exp(p.weight * AMPLIFY));
  const totalWeight = rawWeights.reduce((a, b) => a + b, 0);
  const normalizedWeights = rawWeights.map(w => w / totalWeight);

  // Weighted combination
  const composed = new Float64Array(PROFILE_DIMS);
  for (let i = 0; i < profiles.length; i++) {
    const w = normalizedWeights[i];
    const vec = profiles[i].vector;
    for (let j = 0; j < PROFILE_DIMS; j++) {
      composed[j] += vec[j] * w;
    }
  }

  // Compute coherence: average pairwise cosine similarity between profiles
  let totalSim = 0;
  let pairCount = 0;
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      totalSim += cosineSimilarity(profiles[i].vector, profiles[j].vector);
      pairCount++;
    }
  }
  const coherenceScore = pairCount > 0 ? totalSim / pairCount : 1.0;

  // Decode the composed profile into an instruction block
  const instructionBlock = decodeComposedProfile(composed, profiles);

  return {
    composedVector: composed,
    contributors: profiles,
    instructionBlock,
    count: profiles.length,
    coherenceScore,
  };
}

// ── Decoding ──────────────────────────────────────────────────────────────────

/**
 * Decode a composed profile into a natural-language instruction block.
 *
 * Rather than trying to reverse-engineer the vector (which would require
 * a neural decoder), we merge the instruction texts of contributors in
 * a structured way, ordered by weight. The vector remains useful for
 * similarity comparisons and cache-key generation.
 */
function decodeComposedProfile(
  _composedVector: Float64Array,
  profiles: BehaviorProfile[],
): string {
  if (profiles.length === 0) return '';

  // Sort profiles by weight descending
  const sorted = [...profiles].sort((a, b) => b.weight - a.weight);

  const parts: string[] = [];
  parts.push('<behavior_profile>');
  parts.push(`Composed from ${profiles.length} behavior source(s):`);

  // Group by source type
  const bySource = new Map<BehaviorProfile['source'], BehaviorProfile[]>();
  for (const p of sorted) {
    const arr = bySource.get(p.source) || [];
    arr.push(p);
    bySource.set(p.source, arr);
  }

  const sourceLabels: Record<BehaviorProfile['source'], string> = {
    memory: '📖 Past Experience',
    rule: '🧠 Learned Rules',
    project: '📐 Project Context',
    skill: '🔧 Active Skills',
  };

  for (const [source, group] of bySource) {
    const maxWeight = Math.max(...group.map(p => p.weight));
    const label = sourceLabels[source] || source;
    const emphasis = maxWeight > 0.7 ? ' (high priority)' : maxWeight > 0.4 ? ' (medium priority)' : '';
    parts.push(`\n${label}${emphasis}:`);

    for (const p of group) {
      if (p.instruction) {
        parts.push(p.instruction);
      }
    }
  }

  // Add coherence insight
  const sortedByWeight = [...profiles].sort((a, b) => b.weight - a.weight);
  if (sortedByWeight.length > 1) {
    const top = sortedByWeight[0];
    const runnerUp = sortedByWeight[1];
    if (top.weight > runnerUp.weight * 1.5) {
      parts.push(`\nPrimary directive: ${top.label} (weight ${(top.weight * 100).toFixed(0)}%)`);
    }
  }

  parts.push('</behavior_profile>');

  return parts.join('\n');
}

/**
 * Get a cache key for a composed profile (for deduplication).
 * Uses the composed vector to detect near-identical compositions.
 */
export function getComposedCacheKey(composed: ComposedProfile): string {
  // Sum first 10 dimensions as a quick fingerprint
  let fp = 0;
  for (let i = 0; i < Math.min(10, composed.composedVector.length); i++) {
    fp = ((fp << 5) - fp) + Math.round(composed.composedVector[i] * 1e6);
    fp = fp & fp; // Convert to 32-bit integer
  }
  return `cp_${composed.count}_${fp}`;
}

/**
 * Format a composed profile as a prompt block for system prompt injection.
 * Returns empty string if no profile.
 */
export function formatComposedProfile(composed: ComposedProfile | null): string {
  if (!composed || composed.count === 0) return '';
  return `\n${composed.instructionBlock}\n`;
}
