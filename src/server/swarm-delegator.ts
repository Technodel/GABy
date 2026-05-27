/**
 * SUNy Swarm Delegator â€” spawns parallel multi-model sub-agents.
 *
 * Architecture:
 *   1. Main agent calls `delegate_swarm({ tasks: [...] })`
 *   2. The delegator spins up `Promise.all` generating independent AI executions
 *   3. Each agent in the swarm gets its own limited toolset
 *   4. The delegator waits for all to finish and merges the results
 */

import { generateText, stepCountIs, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { createPowerTools } from './power-tools';
import type { AgentMessage } from './agent';
import { runSubtask, type SubtaskContext, type SubtaskInput } from './subtask-delegator';

export interface SwarmInput {
  overall_goal: string;
  tasks: Array<{
    task: string;
    files: string[];
    success_criteria: string;
    role: 'frontend' | 'backend' | 'qa' | 'database';
  }>;
}

export interface DelegatorContext {
  getContext: () => SubtaskContext;
  getSystemPrompt: () => string;
  getHistory: () => AgentMessage[];
}

export function createSwarmDelegatorTool(ctx: DelegatorContext) {
  return tool({
    description:
      'Delegate multiple focused sub-tasks to a parallel Swarm of AI agents. Use this ONLY for massive features where frontend, backend, and tests can be written simultaneously. Do NOT use if tasks strictly depend on each other sequentially.',
    inputSchema: z.object({
      overall_goal: z.string().describe('The master goal that the swarm is trying to achieve.'),
      tasks: z.array(z.object({
        task: z.string().describe('Specific task for this swarm agent.'),
        files: z.array(z.string()).describe('Files this agent is allowed to edit.'),
        success_criteria: z.string().describe('How this agent knows it is done.'),
        role: z.enum(['frontend', 'backend', 'qa', 'database']).describe('The specialized role of this swarm agent.'),
      })).min(2).max(4).describe('List of 2 to 4 parallel tasks to execute.'),
    }),
    execute: async (input) => {
      const subtaskCtx = ctx.getContext();
      console.log(`[swarm] Spawning ${input.tasks.length} agents for goal: "${input.overall_goal.slice(0, 50)}..."`);

      // Spawn all tasks in parallel using Promise.all
      // Each task goes through two-stage review: spec compliance -> code quality
      const promises = input.tasks.map(async (taskDef) => {
        const subInput: SubtaskInput = {
          task: `[ROLE: ${taskDef.role.toUpperCase()}] ${taskDef.task}`,
          files: taskDef.files,
          goal: input.overall_goal,
          success_criteria: taskDef.success_criteria,
          max_steps: 6,
        };

        // Stage 1: Implementation
        let result = await runSubtask(subtaskCtx, subInput);

        if (result.success) {
          // Stage 2a: Spec compliance review
          const specReview = await runSubtask(subtaskCtx, {
            task: `[SPEC COMPLIANCE REVIEW] Review the following work against the spec. Spec: "${taskDef.task}". Success criteria: "${taskDef.success_criteria}". Files changed: ${result.changed_files.join(', ') || 'none'}. Implementation summary: ${result.summary}. ONLY check: does the code match the spec exactly? Nothing extra, nothing missing? Reply with PASS or FAIL and brief reason.`,
            files: taskDef.files,
            goal: input.overall_goal,
            success_criteria: 'PASS or FAIL verdict with reason',
            max_steps: 2,
          });

          // If spec review fails, fix then re-review once
          if (specReview.success && specReview.summary.toLowerCase().includes('fail')) {
            result = await runSubtask(subtaskCtx, {
              task: `[SPEC FIX] Fix spec compliance issues: ${specReview.summary}. Original task: ${taskDef.task}`,
              files: taskDef.files,
              goal: input.overall_goal,
              success_criteria: taskDef.success_criteria,
              max_steps: 4,
            });
          }

          // Stage 2b: Code quality review (only if spec passed)
          if (result.success) {
            const qualityReview = await runSubtask(subtaskCtx, {
              task: `[CODE QUALITY REVIEW] Review code quality for files: ${result.changed_files.join(', ') || taskDef.files.join(', ')}. Check: naming, duplication, error handling, edge cases. Reply with APPROVED or ISSUES and brief reason.`,
              files: taskDef.files,
              goal: input.overall_goal,
              success_criteria: 'APPROVED or ISSUES verdict',
              max_steps: 2,
            });

            // One fix pass for quality issues
            if (qualityReview.success && qualityReview.summary.toLowerCase().includes('issues')) {
              result = await runSubtask(subtaskCtx, {
                task: `[QUALITY FIX] Fix code quality issues: ${qualityReview.summary}. Files: ${taskDef.files.join(', ')}`,
                files: taskDef.files,
                goal: input.overall_goal,
                success_criteria: 'Code quality issues resolved',
                max_steps: 3,
              });
            }
          }
        }

        return { role: taskDef.role, result };
      });

      const results = await Promise.all(promises);

      // Merge results
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let combinedSummary = `âš¡ SWARM EXECUTION COMPLETE (${results.length} agents)\n\n`;

      for (const { role, result } of results) {
        totalInputTokens += result.input_tokens;
        totalOutputTokens += result.output_tokens;
        
        combinedSummary += `--- Agent: ${role.toUpperCase()} ---\n`;
        combinedSummary += `Status: ${result.success ? 'âœ… Success' : 'âš ï¸ Failed'}\n`;
        if (result.changed_files.length) {
          combinedSummary += `Files Changed:\n${result.changed_files.map(f => `  â€¢ ${f}`).join('\n')}\n`;
        }
        if (result.errors.length) {
          combinedSummary += `Errors:\n${result.errors.map(e => `  â€¢ ${e}`).join('\n')}\n`;
        }
        combinedSummary += `Summary: ${result.summary}\n\n`;
      }

      combinedSummary += `â€” Total Swarm Tokens: ${totalInputTokens} in / ${totalOutputTokens} out â€”`;
      return combinedSummary;
    },
  });
}
