/**
 * SUNy Swarm Delegator — spawns parallel multi-model sub-agents.
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
      const promises = input.tasks.map(async (taskDef) => {
        const subInput: SubtaskInput = {
          task: `[ROLE: ${taskDef.role.toUpperCase()}] ${taskDef.task}`,
          files: taskDef.files,
          goal: input.overall_goal,
          success_criteria: taskDef.success_criteria,
          max_steps: 6,
        };
        
        const result = await runSubtask(subtaskCtx, subInput);
        return { role: taskDef.role, result };
      });

      const results = await Promise.all(promises);

      // Merge results
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let combinedSummary = `⚡ SWARM EXECUTION COMPLETE (${results.length} agents)\n\n`;

      for (const { role, result } of results) {
        totalInputTokens += result.input_tokens;
        totalOutputTokens += result.output_tokens;
        
        combinedSummary += `--- Agent: ${role.toUpperCase()} ---\n`;
        combinedSummary += `Status: ${result.success ? '✅ Success' : '⚠️ Failed'}\n`;
        if (result.changed_files.length) {
          combinedSummary += `Files Changed:\n${result.changed_files.map(f => `  • ${f}`).join('\n')}\n`;
        }
        if (result.errors.length) {
          combinedSummary += `Errors:\n${result.errors.map(e => `  • ${e}`).join('\n')}\n`;
        }
        combinedSummary += `Summary: ${result.summary}\n\n`;
      }

      combinedSummary += `— Total Swarm Tokens: ${totalInputTokens} in / ${totalOutputTokens} out —`;
      return combinedSummary;
    },
  });
}
