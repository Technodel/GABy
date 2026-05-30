export function summarizeErrorOutput(output: string): string {
  const lines = output.split('\n');
  const summary: string[] = [];

  // Line 1: Extract error type (TypeError, SyntaxError, Test failed, etc.)
  const errorMatch = output.match(/(?:Error|Failed|FAILED|ERROR)[\s:]*([^\n]+)/);
  if (errorMatch) summary.push(`Error: ${errorMatch[1]}`);

  // Location: file:line:col
  const locMatch = output.match(/(?:at\s+)?([^\/\s:]+\.(?:ts|tsx|js))[:\s]+(\d+)[:\s](\d+)?/);
  if (locMatch) summary.push(`Location: ${locMatch[1]}:${locMatch[2]}`);

  // Key assertion (for test failures)
  const assertMatch = output.match(/(?:Expected|Expected:|assert[^:]*:)\s*(.+?)(?:\n|$)/i);
  if (assertMatch) summary.push(`Assertion: ${assertMatch[1]}`);

  // Count of failures
  const failureCount = output.match(/(\d+)\s+(?:failed|failing)/i);
  if (failureCount) summary.push(`Total failures: ${failureCount[1]}`);

  // Return summary, fallback to first 500 chars of output if extraction failed
  if (summary.length > 0) {
    return summary.join('\n');
  }
  
  return output.slice(0, 500) + (output.length > 500 ? `\n[...${output.length - 500} more chars]` : '');
}
