const fs = require('fs');

const agentLoopPath = 'src/server/agent-loop.ts';
let code = fs.readFileSync(agentLoopPath, 'utf8');

// 1. Extract model factory
const modelFactoryPath = 'src/server/model-factory.ts';
const modelFactoryCode = `import { getModelsForMode, getVisionCapableModels, classifyTaskType, reorderModelsForProTask } from './agent';
import { resolveModelsForTier } from './model-distribution-engine';

export async function resolveModelsForTurn(resolvedMode: string, imageData: string | null, userMessage: string) {
  const isVisionRequest = !!imageData;
  let modelEntries = isVisionRequest
    ? await (async () => {
        const vision = await getVisionCapableModels();
        if (vision.length > 0) {
          console.log(\`[model-factory] Using vision-capable models: \${vision.map(v => v.provider).join(', ')}\`);
          return vision;
        }
        console.warn('[model-factory] imageData present but no vision-capable model found');
        return [];
      })()
    : await resolveModelsForTier(resolvedMode);

  if (resolvedMode === 'pro' && modelEntries.length >= 2) {
    const taskType = classifyTaskType(userMessage);
    const prevOrder = modelEntries.map(e => e.provider).join(' -> ');
    modelEntries = reorderModelsForProTask(modelEntries, taskType);
    const newOrder = modelEntries.map(e => e.provider).join(' -> ');
    if (prevOrder !== newOrder) {
      console.log(\`[model-factory] Pro task-routing: "\${taskType}" -> \${newOrder}\`);
    }
  }
  return modelEntries;
}
`;
fs.writeFileSync(modelFactoryPath, modelFactoryCode);

// Replace model resolution in agent-loop.ts
const modelResRegex = /\/\/ When imageData is present[\s\S]*?(?=let lastError: Error)/;
code = code.replace(modelResRegex, `let modelEntries = await resolveModelsForTurn(resolvedMode, imageData, userMessage);\n\n  `);

// 2. Extract system prompt builder
const systemPromptBuilderPath = 'src/server/system-prompt-builder.ts';
const systemPromptBuilderCode = `import { getEditFormat } from './agent';
import { DIFF_FORMAT_INSTRUCTIONS, WHOLE_FORMAT_INSTRUCTIONS, ARCHITECT_PLAN_INSTRUCTIONS } from './edit-format-parser';

export async function buildDynamicSystemPrompt(
  systemPrompt: string,
  projectPath: string | null,
  talkMode: boolean,
  resolvedMode: string,
  autoExecuteOverride?: boolean
): Promise<string> {
  const editFormat = (projectPath && !talkMode) ? await getEditFormat() : 'tool-call';
  const textFormat = editFormat === 'diff' || editFormat === 'whole';

  let formatSystemAddition = '';
  if (textFormat && projectPath) {
    formatSystemAddition = '\\n\\n' + (editFormat === 'diff' ? DIFF_FORMAT_INSTRUCTIONS : WHOLE_FORMAT_INSTRUCTIONS);
  }
  if (talkMode) {
    formatSystemAddition += '\\n\\n[TALK MODE] You are in Talk Mode. Do NOT write to, create, or edit any files. Only reason, explain, and discuss. If the user asks you to edit something, explain what you would do but do not call any file tools.';
  }

  const architectPlanSystem = editFormat === 'architect'
    ? \`\${systemPrompt}\\n\\n\${ARCHITECT_PLAN_INSTRUCTIONS}\\n\\n<WorkingDirectory>\${projectPath ?? '(no project)'}</WorkingDirectory>\`
    : null;

  let fullSystem = architectPlanSystem ?? (projectPath
    ? \`\${systemPrompt}\${formatSystemAddition}\\n\\n<WorkingDirectory>\${projectPath}</WorkingDirectory>\\nAll relative file paths are resolved against this directory.\`
    : systemPrompt + formatSystemAddition);

  if (!talkMode && (resolvedMode === 'smart' || resolvedMode === 'pro') && autoExecuteOverride !== true) {
    fullSystem += \`\\n\\n<planning_mode>
CRITICAL INSTRUCTION: You are in Planning Mode because this is a complex task.
Before you make ANY code changes using file_write or file_edit, you MUST:
1. Research the codebase using grep_search, list_dir, and file_read.
2. Present your detailed implementation plan as a normal chat message (using markdown) so the user can easily read it.
3. THEN, immediately use the request_checkpoint tool with a short 1-sentence summary in the details field to formally ask for approval.
4. Wait for the user to approve the checkpoint. If approved, you may proceed with the edits.
</planning_mode>\`;
  }
  return fullSystem;
}
`;
fs.writeFileSync(systemPromptBuilderPath, systemPromptBuilderCode);

// Replace system prompt building in agent-loop.ts
const spbRegex = /\/\/ Determine edit format \(needs true, must come before fullSystem\)[\s\S]*?(?=\/\/ ┌── Runtime skill classification)/;
code = code.replace(spbRegex, `let fullSystem = await buildDynamicSystemPrompt(systemPrompt, projectPath, talkMode, resolvedMode, req.autoExecuteOverride);\n\n  `);

// Add imports
code = code.replace(`import { streamText`, `import { resolveModelsForTurn } from './model-factory';\nimport { buildDynamicSystemPrompt } from './system-prompt-builder';\nimport { streamText`);

// 3. Move session-manager logic
// Actually the user wants to split into session-manager, model-factory, system-prompt-builder.
// Instead of creating session-manager, I'll rename agent-loop.ts to session-manager.ts,
// and create a stub agent-loop.ts that exports session-manager.ts to not break imports in ws-handler.ts.
fs.writeFileSync('src/server/session-manager.ts', code);
fs.writeFileSync('src/server/agent-loop.ts', `export * from './session-manager';\n`);

console.log('Refactor complete.');
