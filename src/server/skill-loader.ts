/**
 * skill-loader.ts — SUNy Skill System
 *
 * Loads SKILL.md files from the skills/ directory, parses YAML frontmatter
 * and markdown sections, and provides runtime task classification.
 *
 * Architecture:
 *   skillLoader.loadAll()         → scan skills/ dir, parse all SKILL.md
 *   skillLoader.getSkillSystemPrompt()  → full block for system prompt injection
 *   skillLoader.classifyTask(msg)      → which phase/skill matches the task
 *   skillLoader.getActiveSkills(msg)    → skill instructions relevant to task
 *
 * Each skill has:
 *   - name, description (YAML frontmatter)
 *   - overview, when-to-use, process, common-rationalizations, red-flags, verification (sections)
 *   - raw full text (for injection)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as fsp from 'fs/promises';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SkillFrontmatter {
  name: string;
  description: string;
}

export interface SkillSections {
  overview: string;
  whenToUse: string;
  process: string;
  commonRationalizations: string;
  redFlags: string;
  verification: string;
}

export interface Skill {
  frontmatter: SkillFrontmatter;
  sections: Partial<SkillSections>;
  raw: string;
  filePath: string;
}

export type TaskPhase = 'define' | 'plan' | 'build' | 'verify' | 'review' | 'ship' | 'unknown';

export interface Classification {
  phase: TaskPhase;
  skillName: string | null;
  confidence: number; // 0-1
}

// ── Phase keywords — maps task content to phase ────────────────────────────

const PHASE_KEYWORDS: Record<TaskPhase, RegExp[]> = {
  define: [
    /new project/i, /new feature/i, /requirements/i, /spec/i,
    /what should/i, /idea/i, /concept/i, /design doc/i,
  ],
  plan: [
    /plan/i, /break down/i, /task list/i, /milestone/i,
    /architecture/i, /design decision/i, /approach/i, /strategy/i,
  ],
  build: [
    /implement/i, /build/i, /code/i, /create/i, /add/i,
    /write/i, /develop/i, /refactor/i, /migrate/i, /change/i,
    /feat/i, /feature/i, /component/i, /api/i, /function/i,
  ],
  verify: [
    /test/i, /debug/i, /fix/i, /error/i, /bug/i, /crash/i,
    /broken/i, /issue/i, /fail/i, /wrong/i, /lint/i, /compile/i,
  ],
  review: [
    /review/i, /audit/i, /inspect/i, /check/i, /quality/i,
    /security/i, /performance/i, /optimize/i, /validate/i,
  ],
  ship: [
    /deploy/i, /release/i, /ship/i, /launch/i, /publish/i,
    /ci/i, /cd/i, /pipeline/i, /production/i, /go live/i,
  ],
  unknown: [],
};

// ── Phase to skill name mapping ────────────────────────────────────────────

const PHASE_TO_SKILL: Record<TaskPhase, string | null> = {
  define: 'spec-driven-development',
  plan: 'spec-driven-development',
  build: 'incremental-implementation',
  verify: 'debugging-and-error-recovery',
  review: 'code-review-and-quality',
  ship: 'code-review-and-quality',
  unknown: null,
};

// ── YAML frontmatter parser ────────────────────────────────────────────────

function parseYamlFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } | null {
  // Normalize CRLF → LF (Windows line endings break the regex)
  const normalized = raw.replace(/\r\n/g, '\n');
  // Match --- frontmatter ---
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const yamlBlock = match[1];
  const body = match[2];

  const frontmatter: Record<string, string> = {};
  for (const line of yamlBlock.split('\n')) {
    const kvMatch = line.match(/^(\w+):\s*(.+)$/);
    if (kvMatch) {
      frontmatter[kvMatch[1]] = kvMatch[2].trim();
    }
  }

  return { frontmatter, body };
}

// ── Extract sections from markdown body ────────────────────────────────────

function extractSections(body: string): Partial<SkillSections> {
  const sections: Partial<SkillSections> = {};

  // Map markdown headings to section keys
  const sectionHeaders: Record<string, keyof SkillSections> = {
    'overview': 'overview',
    'when to use': 'whenToUse',
    'the gated workflow': 'process',
    'the 5-step triage workflow': 'process',
    'the doubt loop': 'process',
    'the increment cycle': 'process',
    'the five-axis review': 'process',
    'common rationalizations': 'commonRationalizations',
    'red flags': 'redFlags',
    'verification': 'verification',
    'implementation rules': 'process',
    'slicing strategies': 'process',
  };

  // Split by ## headings
  const headingRegex = /^##\s+(.+)$/gm;
  let lastMatch: RegExpExecArray | null = null;
  let currentKey: keyof SkillSections | null = null;
  let currentContent: string[] = [];

  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const hMatch = lines[i].match(/^##\s+(.+)$/);
    if (hMatch) {
      // Save previous section
      if (currentKey && currentContent.length > 0) {
        sections[currentKey] = currentContent.join('\n').trim();
      }

      const headingLower = hMatch[1].toLowerCase().trim();
      currentKey = null;
      for (const [key, val] of Object.entries(sectionHeaders)) {
        if (headingLower === key || headingLower.startsWith(key)) {
          currentKey = val;
          break;
        }
      }
      currentContent = [];
    } else if (currentKey) {
      currentContent.push(lines[i]);
    }
  }

  // Save last section
  if (currentKey && currentContent.length > 0) {
    sections[currentKey] = currentContent.join('\n').trim();
  }

  return sections;
}

// ── Skill Registry ─────────────────────────────────────────────────────────

class SkillRegistry {
  private skills: Map<string, Skill> = new Map();
  private loaded = false;
  private skillsDir: string;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  async loadAll(): Promise<void> {
    this.skills.clear();

    if (!fs.existsSync(this.skillsDir)) {
      console.warn(`[skill-loader] Skills directory not found: ${this.skillsDir}`);
      this.loaded = true;
      return;
    }

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = path.join(this.skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;

      try {
        const raw = await fsp.readFile(skillPath, 'utf-8');
        const parsed = parseYamlFrontmatter(raw);

        if (!parsed || !parsed.frontmatter.name) {
          console.warn(`[skill-loader] Invalid SKILL.md (no frontmatter/name): ${skillPath}`);
          continue;
        }

        const sections = extractSections(parsed.body);

        const skill: Skill = {
          frontmatter: {
            name: parsed.frontmatter.name,
            description: parsed.frontmatter.description || '',
          },
          sections,
          raw,
          filePath: skillPath,
        };

        this.skills.set(skill.frontmatter.name, skill);
        console.log(`[skill-loader] Loaded skill: ${skill.frontmatter.name}`);
      } catch (err) {
        console.warn(`[skill-loader] Failed to load ${skillPath}:`, (err as Error).message);
      }
    }

    this.loaded = true;
    console.log(`[skill-loader] Loaded ${this.skills.size} skill(s) from ${this.skillsDir}`);
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}

// ── Classifier ─────────────────────────────────────────────────────────────

function classifyTaskInternal(userMessage: string): Classification {
  const lower = userMessage.toLowerCase();

  // Score each phase by keyword matches
  let bestPhase: TaskPhase = 'unknown';
  let bestScore = 0;

  for (const [phase, patterns] of Object.entries(PHASE_KEYWORDS) as [TaskPhase, RegExp[]][]) {
    if (phase === 'unknown') continue;
    let score = 0;
    for (const re of patterns) {
      if (re.test(lower)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }

  const confidence = bestScore > 0 ? Math.min(bestScore / 3, 1) : 0;

  return {
    phase: bestPhase,
    skillName: PHASE_TO_SKILL[bestPhase],
    confidence,
  };
}

// ── System Prompt Builder ───────────────────────────────────────────────────

function buildSkillSystemPrompt(skills: Skill[]): string {
  const lines: string[] = [
    '<skill_system>',
    '╔══════════════════════════════════════════════════════════════╗',
    '║  SKILL SYSTEM — Engineering workflow skills                 ║',
    '║  Skills encode structured processes that prevent mistakes.  ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
    'Every task should be approached through the lens of the applicable skill.',
    'Before starting work, check which skill applies to your current task phase.',
    '',
  ];

  for (const skill of skills) {
    const fm = skill.frontmatter;
    lines.push('');
    lines.push(`### Skill: ${fm.name}`);
    lines.push(`${fm.description}`);
    lines.push('');

    // Inject core sections
    const proc = skill.sections.process;
    const ra = skill.sections.commonRationalizations;
    const rf = skill.sections.redFlags;

    if (proc) {
      // Extract first 5 lines of process
      const procLines = proc.split('\n').filter(l => l.trim()).slice(0, 5);
      lines.push('Process:');
      for (const pl of procLines) {
        lines.push(`  ${pl}`);
      }
    }

    if (ra) {
      // Extract rationalizations table rows
      const raLines = ra.split('\n').filter(l => l.includes('|') && l.includes('—'));
      if (raLines.length > 0) {
        lines.push('Common Rationalizations — excuses to avoid:');
        for (const rl of raLines.slice(0, 3)) {
          const cells = rl.split('|').map(c => c.trim()).filter(c => c);
          if (cells.length >= 2) {
            lines.push(`  • "${cells[0]}" → ${cells[1]}`);
          }
        }
      }
    }

    if (rf) {
      const rfLines = rf.split('\n').filter(l => l.trim().startsWith('-'));
      if (rfLines.length > 0) {
        lines.push('Red Flags:');
        for (const fl of rfLines.slice(0, 3)) {
          lines.push(`  ${fl.trim()}`);
        }
      }
    }
  }

  lines.push('');
  lines.push('Skill Classification: Use the decision tree in using-agent-skills');
  lines.push('to determine which skill(s) apply to your current task.');
  lines.push('</skill_system>');

  return lines.join('\n');
}

// ── Singleton ───────────────────────────────────────────────────────────────

const SKILLS_DIR = path.resolve(__dirname, '../../skills');
const registry = new SkillRegistry(SKILLS_DIR);

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize the skill system. Call once at startup (e.g., in index.ts).
 */
export async function initSkillSystem(): Promise<void> {
  if (!registry.isLoaded()) {
    await registry.loadAll();
  }
}

/**
 * Get the full skill system prompt block for injection into the system prompt.
 * Returns empty string if no skills loaded.
 */
export function getSkillSystemPrompt(): string {
  if (!registry.isLoaded()) return '';
  const skills = registry.getAllSkills();
  if (skills.length === 0) return '';
  return buildSkillSystemPrompt(skills);
}

/**
 * Get a compact skill INDEX for the system prompt — name + one-line description
 * only, no inlined process/rationalizations/red-flags. Cuts the skill block from
 * ~50 KB to ~3 KB. The model can ask to read the full SKILL.md via file_read if
 * needed (skills/<name>/SKILL.md).
 */
export function getSkillIndex(): string {
  if (!registry.isLoaded()) return '';
  const skills = registry.getAllSkills();
  if (skills.length === 0) return '';
  const lines: string[] = [
    '─── ENGINEERING SKILLS (index) ───',
    'Skill packs live on disk under `skills/<name>/SKILL.md`. Read the full file',
    'with file_read when you actually need the detailed process for a skill.',
    '',
  ];
  for (const skill of skills) {
    const fm = skill.frontmatter;
    const desc = (fm.description || '').replace(/\s+/g, ' ').trim();
    const short = desc.length > 200 ? desc.slice(0, 200) + '…' : desc;
    lines.push(`- ${fm.name}: ${short}`);
  }
  return lines.join('\n');
}

/**
 * Classify a user message into a task phase and recommended skill.
 */
export function classifyTask(userMessage: string): Classification {
  return classifyTaskInternal(userMessage);
}

/**
 * Get active skills relevant to a user message.
 * Returns skill objects (name + description + process summary).
 */
export function getActiveSkills(userMessage: string): Array<{ name: string; description: string; processSummary: string }> {
  const classification = classifyTask(userMessage);
  const result: Array<{ name: string; description: string; processSummary: string }> = [];

  // Always include the meta-skill
  const metaSkill = registry.getSkill('using-agent-skills');
  if (metaSkill) {
    result.push({
      name: metaSkill.frontmatter.name,
      description: metaSkill.frontmatter.description,
      processSummary: metaSkill.sections.process?.split('\n').slice(0, 3).join('\n') || '',
    });
  }

  // Include the classified skill if there's a match
  if (classification.skillName) {
    const skill = registry.getSkill(classification.skillName);
    if (skill) {
      result.push({
        name: skill.frontmatter.name,
        description: skill.frontmatter.description,
        processSummary: skill.sections.process?.split('\n').slice(0, 3).join('\n') || '',
      });
    }
  }

  return result;
}

/**
 * Get a skill by name (e.g., "spec-driven-development")
 */
export function getSkillByName(name: string): Skill | undefined {
  return registry.getSkill(name);
}

/**
 * Get all loaded skills
 */
export function getAllSkills(): Skill[] {
  return registry.getAllSkills();
}

/**
 * Refresh skills from disk (reload all SKILL.md files)
 */
export async function reloadSkills(): Promise<void> {
  await registry.loadAll();
}
