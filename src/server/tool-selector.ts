const TOOL_GROUPS = {
  fileOps: ['file_read', 'file_write', 'file_edit', 'list_dir', 'path_exists'],
  search: ['grep_search', 'code_search', 'web_search', 'who_imports', 'find_files', 'url_fetch'],
  git: ['git_add', 'git_commit', 'git_diff', 'git_stash', 'git_show'],
  execution: ['bash', 'start_server', 'stop_server', 'run_background_command', 'read_server_logs', 'list_servers'],
  testing: ['run_tests', 'run_lint', 'run_build'],
  refactoring: ['rename_symbol', 'inline_symbol', 'extract_function', 'move_file'],
  caching: ['get_prompt_template'],
  memory: ['save_memory', 'recall_memories'],
  project: ['get_repo_map', 'read_symbols', 'update_user_model', 'code_search', 'find_files'],
  delegation: ['delegate_subtask', 'delegate_swarm', 'invoke_subagent'],
  recovery: ['request_checkpoint', 'self_heal', 'undo_last_edit'],
  misc: ['web_fetch', 'url_fetch', 'browser_automation', 'code_conscience'],
};

// Core tools that MUST always be available in project context, regardless of task type.
// These are the minimum needed for any real agentic coding turn.
const CORE_PROJECT_TOOLS = [
  'file_read', 'file_write', 'file_edit', 'list_dir', 'path_exists',
  'grep_search', 'bash', 'get_repo_map', 'code_search', 'find_files',
  'web_search', 'url_fetch', 'save_memory', 'recall_memories',
  'request_checkpoint', 'read_symbols',
];

export function selectToolsForTask(taskType: string, recentToolCalls: string[]): string[] {
  // Always start from the full core set for project tasks.
  const baseTools = [...CORE_PROJECT_TOOLS];

  // taskType values from classifyAutoMode: 'free' | 'fast' | 'smart' | 'pro'
  // taskType values from classifyTask (skill-loader): 'coding' | 'debug' | 'refactor' | 'research' | 'question' | 'chat'
  // Handle both variants.

  switch (taskType) {
    // skill-loader classifications
    case 'coding':
      baseTools.push(...TOOL_GROUPS.testing, ...TOOL_GROUPS.git, ...TOOL_GROUPS.execution);
      break;
    case 'debug':
      baseTools.push(...TOOL_GROUPS.execution, ...TOOL_GROUPS.testing, ...TOOL_GROUPS.search);
      break;
    case 'refactor':
      baseTools.push(...TOOL_GROUPS.refactoring, ...TOOL_GROUPS.testing, ...TOOL_GROUPS.git);
      break;
    case 'research':
      baseTools.push(...TOOL_GROUPS.search, ...TOOL_GROUPS.project, ...TOOL_GROUPS.misc);
      break;
    case 'question':
    case 'chat':
      baseTools.push('web_search', 'url_fetch');
      break;

    // classifyAutoMode tier names — treat all as full coding context
    case 'free':
    case 'fast':
    case 'smart':
    case 'pro':
      baseTools.push(...TOOL_GROUPS.testing, ...TOOL_GROUPS.execution, ...TOOL_GROUPS.git);
      break;

    default:
      // Unknown type — keep full core tools, add execution group for safety
      baseTools.push(...TOOL_GROUPS.execution, ...TOOL_GROUPS.testing);
      break;
  }

  // Always keep tools that were recently used (agent may chain them across steps)
  if (recentToolCalls && recentToolCalls.length > 0) {
    baseTools.push(...recentToolCalls.slice(-5));
  }

  // De-duplicate and return
  return [...new Set(baseTools)];
}
