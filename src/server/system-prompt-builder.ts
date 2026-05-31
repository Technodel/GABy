import { getEditFormat } from './agent';
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
    formatSystemAddition = '\n\n' + (editFormat === 'diff' ? DIFF_FORMAT_INSTRUCTIONS : WHOLE_FORMAT_INSTRUCTIONS);
  }
  if (talkMode) {
    formatSystemAddition += '\n\n[TALK MODE] You are in Talk Mode. Do NOT write to, create, or edit any files. Only reason, explain, and discuss. If the user asks you to edit something, explain what you would do but do not call any file tools.';
  }

  const architectPlanSystem = editFormat === 'architect'
    ? `${systemPrompt}\n\n${ARCHITECT_PLAN_INSTRUCTIONS}\n\n<WorkingDirectory>${projectPath ?? '(no project)'}</WorkingDirectory>`
    : null;

  let fullSystem = architectPlanSystem ?? (projectPath
    ? `${systemPrompt}${formatSystemAddition}\n\n<WorkingDirectory>${projectPath}</WorkingDirectory>\nAll relative file paths are resolved against this directory.`
    : systemPrompt + formatSystemAddition);

  if (!talkMode && (resolvedMode === 'smart' || resolvedMode === 'pro') && autoExecuteOverride !== true) {
    fullSystem += `\n\n<planning_mode>
CRITICAL INSTRUCTION: You are in Planning Mode because this is a complex task.
Before you make ANY code changes using file_write or file_edit, you MUST:
1. Research the codebase using grep_search, list_dir, and file_read.
2. Present your detailed implementation plan as a normal chat message (using markdown) so the user can easily read it.
3. THEN, immediately use the request_checkpoint tool with a short 1-sentence summary in the details field to formally ask for approval.
4. Wait for the user to approve the checkpoint. If approved, you may proceed with the edits.
</planning_mode>`;
  }
  return fullSystem;
}
