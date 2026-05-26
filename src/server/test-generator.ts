/**
 * SUNy Test Generator â€” auto-scaffold tests for untested files.
 *
 * Analyzes existing test patterns in the project, then generates
 * test files with appropriate imports, describe/it blocks, and mocking.
 * Uses the same LLM for generation but with a focused test-writing prompt.
 *
 * Feature flag: ff_test_generator
 */

import fs from 'fs';
import path from 'path';
import { generateText, type LanguageModel } from 'ai';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Types
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface TestGenInput {
  /** Source file to generate tests for */
  filePath: string;
  /** Project root (for module resolution) */
  projectPath: string;
  /** Content of the source file */
  sourceContent: string;
  /** Existing test file content for the same module (if any) */
  existingTestContent?: string;
  /** Examples of existing test patterns in the project */
  testPatternExamples?: string[];
}

export interface TestGenOutput {
  /** Path where the test file should be created */
  testFilePath: string;
  /** Generated test content */
  testContent: string;
  /** Test framework detected/used */
  framework: 'vitest' | 'jest' | 'mocha' | 'unknown';
  /** Number of test cases generated */
  testCount: number;
  /** Whether the file was actually written */
  written: boolean;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Test detection
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function detectTestFramework(projectPath: string): 'vitest' | 'jest' | 'mocha' | 'unknown' {
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps.vitest) return 'vitest';
      if (allDeps.jest) return 'jest';
      if (allDeps.mocha) return 'mocha';
    }
  } catch {
    // ignore
  }

  // Check for config files
  try {
    if (fs.existsSync(path.join(projectPath, 'vitest.config.ts')) ||
        fs.existsSync(path.join(projectPath, 'vitest.config.js'))) return 'vitest';
    if (fs.existsSync(path.join(projectPath, 'jest.config.ts')) ||
        fs.existsSync(path.join(projectPath, 'jest.config.js'))) return 'jest';
    if (fs.existsSync(path.join(projectPath, '.mocharc.yml')) ||
        fs.existsSync(path.join(projectPath, '.mocharc.json'))) return 'mocha';
  } catch {
    // ignore
  }

  return 'unknown';
}

function getTestFrameworkImports(framework: 'vitest' | 'jest' | 'mocha' | 'unknown'): string {
  switch (framework) {
    case 'vitest':
      return `import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';`;
    case 'jest':
      return `// Jest globals are available without import\n// describe, it, expect, beforeEach, jest`;
    case 'mocha':
      return `import { describe, it, beforeEach, afterEach } from 'mocha';\nimport { expect } from 'chai';`;
    default:
      return `import { describe, it, expect } from 'vitest';`;
  }
}

/**
 * Find test file examples in the project to learn patterns.
 */
export function findTestPatterns(projectPath: string, maxExamples: number = 3): string[] {
  const examples: string[] = [];
  const testDirs = ['__tests__', 'tests', 'test'];

  for (const dir of testDirs) {
    const testPath = path.join(projectPath, dir);
    if (!fs.existsSync(testPath)) continue;

    try {
      const files = fs.readdirSync(testPath).filter(f => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f));
      for (const file of files.slice(0, maxExamples)) {
        const content = fs.readFileSync(path.join(testPath, file), 'utf-8');
        examples.push(`// === ${file} ===\n${content.slice(0, 2000)}`);
      }
    } catch {
      // skip unreadable
    }
  }

  // Also check for co-located tests (file.test.ts beside source)
  if (examples.length < maxExamples) {
    try {
      const srcFiles = fs.readdirSync(projectPath).filter(f => /\.test\.(ts|tsx|js|jsx)$/.test(f));
      for (const file of srcFiles.slice(0, maxExamples)) {
        const content = fs.readFileSync(path.join(projectPath, file), 'utf-8');
        examples.push(`// === ${file} ===\n${content.slice(0, 2000)}`);
      }
    } catch {
      // skip
    }
  }

  return examples;
}

/**
 * Determine the test file path based on project conventions.
 */
export function resolveTestFilePath(sourcePath: string, projectPath: string): string {
  const fileName = path.basename(sourcePath, path.extname(sourcePath));
  const dir = path.dirname(sourcePath);
  const ext = path.extname(sourcePath);

  // Check for __tests__ convention
  const relativeToProject = path.relative(projectPath, sourcePath);
  const parentDir = path.dirname(relativeToProject);

  const testDir = path.join(projectPath, '__tests__', parentDir);
  if (fs.existsSync(path.join(projectPath, '__tests__'))) {
    return path.join(testDir, `${fileName}.test${ext}`);
  }

  // Check for tests/ convention
  const testsDir = path.join(projectPath, 'tests', parentDir);
  if (fs.existsSync(path.join(projectPath, 'tests'))) {
    return path.join(testsDir, `${fileName}.test${ext}`);
  }

  // Check for co-located tests convention (already exists?)
  const coLocated = path.join(dir, `${fileName}.test${ext}`);
  if (fs.existsSync(coLocated)) {
    return coLocated;
  }

  // Default: co-located
  return coLocated;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Test generator
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const TEST_GENERATOR_SYSTEM = `You are an expert test writer. Given a source file, generate a comprehensive test file.

## Rules

1. Cover the main functionality: happy path, error cases, edge cases
2. Use the detected test framework (vitest/jest/mocha)
3. Mock external dependencies (HTTP, file system, database)
4. Include proper setup and teardown where needed
5. Use clear test names that describe the scenario
6. Follow the project's existing test patterns (shown as examples)
7. Do NOT test third-party libraries â€” only test the code in the source file
8. Import only what's needed

## Output Format

Respond with ONLY the test file content â€” no explanations, no markdown code fences around it.

\`\`\`typescript
// Generated test file
import { describe, it, expect } from 'vitest';
// ... rest of test content
\`\`\``;

/**
 * Generate tests for a given source file using the LLM.
 */
export async function generateTests(
  model: LanguageModel,
  input: TestGenInput,
  options?: { signal?: AbortSignal },
): Promise<TestGenOutput> {
  const framework = detectTestFramework(input.projectPath);
  const frameworkImports = getTestFrameworkImports(framework);
  const testFilePath = resolveTestFilePath(input.filePath, input.projectPath);
  const testPatterns = input.testPatternExamples?.length
    ? input.testPatternExamples
    : findTestPatterns(input.projectPath);

  // Count exports in source to estimate test count
  const exportMatches = input.sourceContent.match(/^export\s+(default\s+)?(?:const|function|class|interface|type)\s+/gm);
  const estimatedExports = exportMatches?.length || 1;

  const contextParts: string[] = [
    `## Source File\n${input.filePath}`,
    `\`\`\`typescript\n${input.sourceContent.slice(0, 8000)}\n\`\`\``,
    `\n## Detected Framework\n${framework}`,
  ];

  if (input.existingTestContent) {
    contextParts.push(`\n## Existing Test (update/append)\n\`\`\`typescript\n${input.existingTestContent.slice(0, 3000)}\n\`\`\``);
  }

  if (testPatterns.length > 0) {
    contextParts.push(`\n## Project Test Patterns (follow these conventions)\n${testPatterns.join('\n\n')}`);
  }

  try {
    const result = await generateText({
      model,
      system: TEST_GENERATOR_SYSTEM,
      messages: [{ role: 'user', content: contextParts.join('\n') }],
      maxTokens: 4000,
      abortSignal: options?.signal,
      experimental_telemetry: { isEnabled: false },
    });

    const rawContent = result.text?.trim() ?? '';

    // Extract code from markdown code fences if present
    const codeMatch = rawContent.match(/```(?:\w+)?\s*\n([\s\S]*?)\n```/);
    const testContent = codeMatch ? codeMatch[1].trim() : rawContent;

    return {
      testFilePath,
      testContent,
      framework,
      testCount: countTestCases(testContent),
      written: false,
    };
  } catch (err) {
    return {
      testFilePath,
      testContent: `// Failed to generate tests: ${err instanceof Error ? err.message : 'unknown error'}`,
      framework,
      testCount: 0,
      written: false,
    };
  }
}

/**
 * Write a generated test file to disk.
 */
export function writeTestFile(output: TestGenOutput): TestGenOutput {
  try {
    const dir = path.dirname(output.testFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(output.testFilePath, output.testContent, 'utf-8');
    return { ...output, written: true };
  } catch (err) {
    return { ...output, written: false };
  }
}

/**
 * Count test cases in generated content.
 */
function countTestCases(content: string): number {
  const itMatches = content.match(/\bit\s*\(['"`]/g);
  const testMatches = content.match(/\btest\s*\(['"`]/g);
  return (itMatches?.length || 0) + (testMatches?.length || 0);
}

/**
 * Generate the createTestFile tool description and handler.
 */
export function generateTestToolDefinition(model: LanguageModel, projectPath: string) {
  return {
    description: 'Generate a test file for a given source file. Analyzes the source, detects the test framework, follows project conventions, and writes the test file.',
    handler: async (args: { filePath: string; sourceContent?: string }) => {
      const filePath = path.resolve(projectPath, args.filePath);
      if (!fs.existsSync(filePath)) {
        return `Error: File "${args.filePath}" not found.`;
      }

      const sourceContent = args.sourceContent || fs.readFileSync(filePath, 'utf-8');
      const testPatterns = findTestPatterns(projectPath);

      const testGen = await generateTests(model, {
        filePath,
        projectPath,
        sourceContent,
        testPatternExamples: testPatterns,
      });

      if (testGen.testCount === 0) {
        return `âŒ Failed to generate tests for "${args.filePath}": ${testGen.testContent}`;
      }

      // Check if test file already exists
      if (fs.existsSync(testGen.testFilePath)) {
        return `âš ï¸ Test file already exists at "${testGen.testFilePath}". Generated ${testGen.testCount} test case(s) but did not overwrite.\n\nPreview:\n\`\`\`\n${testGen.testContent.slice(0, 1000)}\n\`\`\``;
      }

      const written = writeTestFile(testGen);
      if (written.written) {
        return `âœ… Generated and wrote ${testGen.testCount} test case(s) to "${testGen.testFilePath}" (${testGen.framework}).`;
      } else {
        return `âŒ Failed to write test file to "${testGen.testFilePath}".`;
      }
    },
  };
}
