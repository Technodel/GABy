/**
 * SUNy Tool Parser — Extracts structured tool calls from AI responses.
 *
 * The AI can request bridge operations by embedding XML-style tags:
 *   <suny_tool name="read_file" path="src/file.tsx" />
 *   <suny_tool name="write_file" path="src/file.tsx">content here</suny_tool>
 *   <suny_tool name="shell" command="npm test" cwd="." />
 *   <suny_tool name="run_tests" cwd="." />
 *   <suny_tool name="start_server" command="npm run dev" cwd="." timeoutSeconds="30" />
 *   <suny_tool name="list_dir" path="src/" />
 *   <suny_tool name="create_file" path="src/new.ts">content here</suny_tool>
 *   <suny_tool name="delete_file" path="src/old.ts" />
 *   <suny_tool name="read_multiple" paths="['src/a.ts','src/b.ts']" />
 *
 * These tags are stripped from the final response shown to the user.
 */

export interface ToolCall {
  name: string;
  params: Record<string, unknown>;
  body?: string;
}

export interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ParsedResponse {
  /** The clean text with all tool tags removed */
  cleanContent: string;
  /** Extracted tool calls in order */
  toolCalls: ToolCall[];
}

const TOOL_CALL_REGEX = /<suny_tool\s+([^>]*?)\/?\s*>(.*?)<\/suny_tool\s*>|<suny_tool\s+([^>]*?)\s*\/\s*>/gis;

/**
 * Regex for <function.name=X>JSON</function> format emitted by some models
 * (e.g. OpenRouter) that don't support native JSON tool calling.
 * Group 1: tool name, Group 2: JSON body (params).
 */
const FUNCTION_TAG_REGEX = /<function\.name=(\w+)>([\s\S]*?)<\/function\s*>/gi;

/**
 * Parse an AI response and extract tool calls, returning clean text + tool calls.
 */
export function parseToolCalls(content: string): ParsedResponse {
  const toolCalls: ToolCall[] = [];
  let cleanContent = content;
  let match: RegExpExecArray | null;

  TOOL_CALL_REGEX.lastIndex = 0;

  while ((match = TOOL_CALL_REGEX.exec(content)) !== null) {
    // match[1] = attributes (paired tag), match[2] = body (paired tag), match[3] = attributes (self-closing)
    const attrsStr = match[1] || match[3] || '';
    const body = match[2]?.trim() || undefined;

    const params = parseAttributes(attrsStr);
    const name = params.name as string;
    delete params.name;

    if (name) {
      toolCalls.push({ name, params, body });
    }
  }

  // Remove all tool tags from the content
  cleanContent = content.replace(TOOL_CALL_REGEX, '').trim();

  // Strip any remaining malformed opener tags the model produced with > instead of />
  // e.g. <suny_tool name="read_file" path="..."> (no self-close slash, no body)
  cleanContent = cleanContent.replace(/<suny_tool\b[^>]*>/gi, '').trim();

  return { cleanContent, toolCalls };
}

function parseAttributes(attrsStr: string): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  // Match key="value" or key='value' or key=value (unquoted)
  const attrRegex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;

  while ((m = attrRegex.exec(attrsStr)) !== null) {
    const key = m[1];
    let value: unknown = m[2] ?? m[3] ?? m[4] ?? '';
    const strValue = String(value);

    // Try to parse JSON values (arrays, numbers, booleans)
    if (strValue.startsWith('[') || strValue.startsWith('{')) {
      try { value = JSON.parse(strValue); } catch { /* keep as string */ }
    } else if (strValue === 'true') { value = true; }
    else if (strValue === 'false') { value = false; }
    else if (/^\d+$/.test(strValue)) { value = parseInt(strValue, 10); }
    else if (/^\d+\.\d+$/.test(strValue)) { value = parseFloat(strValue); }

    attrs[key] = value;
  }
  return attrs;
}

/**
 * Build a result block that gets fed back to the AI.
 */
export function buildToolResultBlock(results: Array<{ call: ToolCall; result: ToolCallResult }>): string {
  const blocks = results.map(r => {
    const status = r.result.success ? 'success' : 'error';
    let dataStr = '';
    if (r.result.data !== undefined) {
      dataStr = typeof r.result.data === 'string'
        ? r.result.data
        : JSON.stringify(r.result.data, null, 2);
      // Truncate very large results
      if (dataStr.length > 10000) {
        dataStr = dataStr.slice(0, 10000) + `\n... [truncated, ${dataStr.length} total chars]`;
      }
    }
    const errStr = r.result.error ? `\nError: ${r.result.error}` : '';
    return `<suny_result name="${r.call.name}" status="${status}">\n${dataStr}${errStr}\n</suny_result>`;
  });

  return [
    '\n\n[SUNy Tool Results]',
    ...blocks,
    '[End Tool Results]\n',
  ].join('\n');
}

/**
 * Check if an AI response contains any tool calls.
 */
export function hasToolCalls(content: string): boolean {
  return /<suny_tool\s+/i.test(content);
}

/**
 * Parse <function.name=X>JSON</function> format emitted by models that
 * don't support native JSON tool calling. The body is a JSON object of
 * parameters for the tool named X.
 */
export function parseFunctionTagCalls(content: string): ParsedResponse {
  const toolCalls: ToolCall[] = [];
  let cleanContent = content;
  let match: RegExpExecArray | null;

  FUNCTION_TAG_REGEX.lastIndex = 0;

  while ((match = FUNCTION_TAG_REGEX.exec(content)) !== null) {
    const toolName = match[1]; // e.g. "glob", "grep", "file_read"
    const bodyStr = (match[2] || '').trim();

    let params: Record<string, unknown> = {};
    if (bodyStr) {
      try {
        params = JSON.parse(bodyStr);
      } catch {
        // Not valid JSON — try to extract key=value pairs as fallback
        params = { _raw: bodyStr };
      }
    }

    if (toolName) {
      toolCalls.push({ name: toolName, params });
    }
  }

  // Remove all function.name tags from content
  cleanContent = content.replace(FUNCTION_TAG_REGEX, '').trim();

  // Also strip any malformed opening tags (e.g. <function.name=glob> without closing)
  cleanContent = cleanContent.replace(/<function\.name=\w+>/gi, '').trim();

  return { cleanContent, toolCalls };
}

/**
 * Check if content contains <function.name=X> tool calls.
 */
export function hasFunctionTagCalls(content: string): boolean {
  return /<function\.name=\w+>/i.test(content);
}
