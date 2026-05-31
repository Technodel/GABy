/**
 * SUNy Narrator â€” translates raw technical agent messages into friendly plain-English text.
 * This is the Phase 8.5 implementation.
 * All output from this module is already firewall-safe (no model names, tokens, etc.)
 */

type MessageType =
  | 'command'
  | 'file_edit'
  | 'search'
  | 'plan'
  | 'complete'
  | 'error'
  | 'thinking'
  | 'test_running'
  | 'test_pass'
  | 'test_fail'
  | 'test_fixing'
  | 'test_loop'
  | 'test_give_up'
  | 'server_starting'
  | 'server_ready'
  | 'server_crashed'
  | 'server_fixing'
  | 'server_restarting'
  | 'server_give_up'
  | 'url_fetch'
  | 'url_fetch_progress';

/**
 * Translate a technical message and type into a friendly narrator string.
 */
export function narrateMessage(rawMessage: string, messageType: MessageType, context?: Record<string, unknown>): string {
  switch (messageType) {
    case 'thinking':
      return 'SUNy is thinking...';

    case 'command': {
      const cmd = rawMessage.toLowerCase();
      // Package management
      if (cmd.includes('npm install') || cmd.includes('npm ci') || cmd.includes('yarn install') || cmd.includes('yarn add') || cmd.includes('pnpm install')) {
        return '📦 Installing your project\'s packages — this usually takes a moment, I\'ll let you know when it\'s done!';
      }
      if (cmd.includes('pip install') || cmd.includes('pip3 install')) {
        return '📦 Installing Python packages for your project...';
      }
      // Build scripts
      const buildMatch = rawMessage.match(/(?:npm run|yarn run|pnpm run)\s+(\S+)/i);
      if (buildMatch) {
        const script = buildMatch[1].toLowerCase();
        if (script === 'build' || script === 'build:prod') return '🔨 Building your project — compiling everything into a clean production bundle...';
        if (script === 'test' || script === 'test:run' || script.includes('test')) return '🧪 Running your tests to make sure everything still works...';
        if (script === 'dev' || script === 'start' || script === 'serve') return '🚀 Starting up your project to see it live...';
        if (script === 'lint' || script === 'lint:fix') return '✨ Checking your code style and cleaning things up...';
        if (script === 'type-check' || script === 'tsc') return '🔍 Double-checking the code for any type errors...';
        if (script === 'migrate' || script.includes('db') || script.includes('seed')) return '💾 Setting up your database...';
        return `⚙️ Running the "${script}" script...`;
      }
      // Git operations
      if (cmd.includes('git add') || cmd.includes('git stage')) return '📌 Staging your changes for the next commit...';
      if (cmd.includes('git commit')) return '💾 Saving a snapshot of your progress...';
      if (cmd.includes('git push')) return '📤 Pushing your changes to the remote repository...';
      if (cmd.includes('git pull') || cmd.includes('git fetch')) return '📥 Pulling the latest changes...';
      if (cmd.includes('git clone')) return '📋 Cloning the project repository...';
      if (cmd.includes('git checkout') || cmd.includes('git switch')) return '🔀 Switching branches...';
      // File operations
      if (cmd.includes('mkdir') || cmd.includes('md ') || cmd.includes('new-item')) return '📁 Creating a new folder for your project...';
      if (cmd.includes('rm ') || cmd.includes('del ') || cmd.includes('remove-item')) return '🗑️ Cleaning up some old files...';
      if (cmd.includes('cp ') || cmd.includes('copy') || cmd.includes('mv ') || cmd.includes('move')) return '📦 Organizing your project files...';
      // Node/Python direct
      if (cmd.includes('node ') || cmd.includes('node.exe')) return '▶️ Running the script to apply your changes...';
      if (cmd.includes('python') || cmd.includes('py ')) return '🐍 Running the Python script...';
      // Navigating
      if (cmd.startsWith('cd ') || cmd.startsWith('set-location')) return '📁 Moving into the project folder...';
      // Generic
      return '⚙️ Running a quick step behind the scenes — won\'t be long!';
    }

    case 'file_edit': {
      const filename = extractFilename(rawMessage) || (context?.filename as string);
      if (filename) {
        const action = rawMessage.toLowerCase().includes('creat') ? 'Creating' :
                       rawMessage.toLowerCase().includes('delet') ? 'Cleaning up' : 'Updating';
        return `✏️ ${action} \`${filename}\`...`;
      }
      return '✏️ Making improvements to your project files...';
    }

    case 'search':
      if (rawMessage.toLowerCase().includes('read') || rawMessage.toLowerCase().includes('open')) {
        const f = extractFilename(rawMessage);
        if (f) return `👀 Reading \`${f}\` to understand the code...`;
      }
      return '🔍 Exploring your project files to understand how everything fits together...';

    case 'plan': {
      const steps = extractPlanSteps(rawMessage);
      if (steps.length > 0) return formatFriendlyPlan(steps);
      return '📋 Got a plan! Working on it now...';
    }

    case 'complete': {
      const summary = extractCompletionSummary(rawMessage);
      return summary ? `✅ All done! ${summary}` : '✅ Done! Everything looks great.';
    }

    case 'error':
      return "Hmm, hit a snag — let me try a different approach 💪";

    case 'test_running':
      return "🧪 Running your project's tests to make sure everything works...";

    case 'test_pass': {
      const count = context?.count as number;
      return count ? `✅ All ${count} tests passed — looking great!` : '✅ All tests passed — looking great!';
    }

    case 'test_fail': {
      const count = context?.count as number;
      return count ? `⚠️ ${count} test(s) didn't pass — I'm fixing them now...` : "⚠️ A few tests didn't pass — I'm fixing them now...";
    }

    case 'test_fixing':
      return '🔧 Adjusting the code based on test results...';

    case 'test_loop': {
      const attempt = context?.attempt as number;
      return attempt ? `🔄 Running tests again (attempt ${attempt})...` : '🔄 Running tests again...';
    }

    case 'test_give_up':
      return "I've made significant progress on the tests. A couple of edge cases remain — want me to keep going?";

    case 'server_starting':
      return '🚀 Starting up your project to make sure it runs...';

    case 'server_ready':
      return '✅ Project started successfully — everything looks clean!';

    case 'server_crashed':
      return '⚠️ The project hit a startup error — I\'m fixing it now...';

    case 'server_fixing':
      return '🔧 Patching the startup issue...';

    case 'server_restarting':
      return '🔄 Restarting to check if the fix worked...';

    case 'server_give_up':
      return 'I fixed the main startup issues. One thing needs a closer look — want me to continue?';

    case 'url_fetch': {
      const url = context?.url as string;
      if (url) return `🌐 SUNy is fetching ${url}...`;
      return '🌐 SUNy is fetching information from the web...';
    }

    case 'url_fetch_progress': {
      const bytes = context?.bytes as number;
      const kb = Math.round(bytes / 1024);
      if (kb > 0) return `🌐 SUNy is downloading data (${kb}KB so far)...`;
      return '🌐 SUNy is downloading data...';
    }

    default:
      return rawMessage.length > 0 ? sanitizeRawForNarrator(rawMessage) : 'Working on it...';
  }
}

/**
 * Auto-detect message type from raw agent output and narrate it.
 * Used when the message type is not explicitly known.
 */
export function autoNarrate(rawMessage: string): string {
  const lower = rawMessage.toLowerCase();

  if (lower.includes('running') && (lower.includes('test') || lower.includes('spec'))) {
    return narrateMessage(rawMessage, 'test_running');
  }
  if ((lower.includes('edit') || lower.includes('write') || lower.includes('update') || lower.includes('creat')) && lower.includes('file')) {
    return narrateMessage(rawMessage, 'file_edit');
  }
  if (lower.includes('search') || lower.includes('read') || lower.includes('look') || lower.includes('explor')) {
    return narrateMessage(rawMessage, 'search');
  }
  if (lower.includes('plan') || lower.includes('step') || lower.includes('will')) {
    return narrateMessage(rawMessage, 'plan');
  }
  if (lower.includes('done') || lower.includes('complet') || lower.includes('finish')) {
    return narrateMessage(rawMessage, 'complete');
  }
  if (lower.includes('error') || lower.includes('fail') || lower.includes('exception')) {
    return narrateMessage(rawMessage, 'error');
  }
  if (lower.includes('command') || lower.includes('npm') || lower.includes('python') || lower.includes('git')) {
    return narrateMessage(rawMessage, 'command');
  }

  return narrateMessage(rawMessage, 'thinking');
}

// --- Helpers ---

function extractFilename(text: string): string | null {
  // Match common patterns like "editing src/App.tsx" or "writing path/to/file.ts"
  const match = text.match(/(?:edit|write|updat|creat|modif)[^\s]*\s+([^\s]+\.[a-z]+)/i);
  if (match) return match[1];
  // Match quoted filenames
  const quoted = text.match(/["']([^"']+\.[a-z]{2,5})["']/i);
  if (quoted) return quoted[1];
  return null;
}

function extractPlanSteps(text: string): string[] {
  const lines = text.split('\n').filter(l => l.match(/^\s*[-*\d]+[.)]\s+.+/));
  return lines.slice(0, 5).map(l => l.replace(/^\s*[-*\d]+[.)]\s+/, '').trim());
}

function formatFriendlyPlan(steps: string[]): string {
  if (steps.length === 0) return '📋 Got a plan! Working on it now...';
  const items = steps.map(s => `• ${sanitizeRawForNarrator(s)}`).join('\n');
  return `📋 Here's my plan:\n${items}`;
}

function extractCompletionSummary(text: string): string {
  // Count file edits mentioned
  const fileMatches = text.match(/\.(tsx?|jsx?|py|rs|go|css|html|json)\b/gi);
  if (fileMatches && fileMatches.length > 0) {
    const count = new Set(fileMatches).size;
    return `I updated ${count} file${count > 1 ? 's' : ''} for you!`;
  }
  return '';
}

function sanitizeRawForNarrator(text: string): string {
  // Do not strip paths or commands anymore so the user knows what SUNy is really doing
  return text.trim();
}
