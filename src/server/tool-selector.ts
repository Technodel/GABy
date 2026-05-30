const TOOL_GROUPS = {
  fileOps: ['file_read', 'file_write', 'file_edit', 'list_dir', 'path_exists'],
  search: ['grep_search', 'code_search', 'web_search', 'who_imports', 'find_files'],
  git: ['git_add', 'git_commit', 'git_diff', 'git_stash', 'git_show'],
  execution: ['bash', 'start_server', 'stop_server', 'run_background_command'],
  testing: ['run_tests', 'run_lint', 'run_build'],
  refactoring: ['rename_symbol', 'inline_symbol', 'extract_function', 'move_file'],
  caching: ['get_prompt_template', 'read_server_logs', 'list_servers'],
  memory: ['save_memory', 'recall_memories'],
  project: ['get_repo_map', 'read_symbols', 'update_user_model'],
  delegation: ['delegate_subtask', 'delegate_swarm', 'invoke_subagent'],
  recovery: ['request_checkpoint', 'self_heal', 'undo_last_edit'],
  misc: ['web_fetch', 'url_fetch', 'browser_automation', 'code_conscience'],
};

export function selectToolsForTask(taskType: string, recentToolCalls: string[]): string[] {
  // Start with a core set
  const baseTools = ['file_read', 'bash', 'get_repo_map'];

  // Add groups based on task type
  if (taskType === 'coding') {
    baseTools.push(...TOOL_GROUPS.fileOps, ...TOOL_GROUPS.testing, ...TOOL_GROUPS.git);
  } else if (taskType === 'question' || taskType === 'chat') {
    baseTools.push('web_search', 'url_fetch');
  } else if (taskType === 'refactor') {
    baseTools.push(...TOOL_GROUPS.refactoring, ...TOOL_GROUPS.fileOps, ...TOOL_GROUPS.testing);
  } else if (taskType === 'debug') {
    baseTools.push(...TOOL_GROUPS.search, ...TOOL_GROUPS.execution, ...TOOL_GROUPS.testing);
  } else if (taskType === 'research') {
    baseTools.push(...TOOL_GROUPS.search, ...TOOL_GROUPS.project, ...TOOL_GROUPS.misc);
  }

  // Keep tools that were just used (agent might chain them)
  if (recentToolCalls) {
    baseTools.push(...recentToolCalls.slice(-3));
  }

  // De-duplicate and return
  return [...new Set(baseTools)];
}
