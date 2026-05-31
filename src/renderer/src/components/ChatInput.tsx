import { Send, Square, Paperclip, MessageSquare, Pencil, Mic, MicOff, Terminal } from 'lucide-react';
import { useRef, useState } from 'react';
import type { Message } from '../types';

interface ChatInputProps {
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  balance: number;
  walletBalance: number;
  thinking: boolean;
  selectedMode: string;
  activeProject: { id: number; name: string; local_path: string; persona?: string | null } | null;
  talkMode: boolean;
  noBalance: boolean;
  imagePreview: string | null;
  setImagePreview: React.Dispatch<React.SetStateAction<string | null>>;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  inputHistoryIndex: React.MutableRefObject<number>;
  messages: Message[];
  sendMessage: () => void;
  toggleTalkMode: () => void;
  wsSend: (msg: Record<string, unknown>) => void;
  addMessage: (type: 'user' | 'suny' | 'system', content: string, extra?: Record<string, unknown>) => void;
  isListening?: boolean;
  onVoiceToggle?: () => void;
  autoExecute?: boolean;
  toggleAutoExecute?: () => void;
}

const PLACEHOLDERS = [
  'What are we building today?',
  'Describe your goal — SUNy will handle the rest.',
  'Got a bug? Paste the error and let SUNy trace it.',
  'Tell me what to build and I will write, run, and verify it.',
  'What feature should we add next?',
  'Drop a task, a question, or just say hi.',
  'Need a code review? Paste the file and ask.',
  'What should SUNy tackle for you today?',
  'Start with a goal, not a file — I will find what to edit.',
  'Describe the problem. I will diagnose it.',
  'Ask anything — architecture, debugging, or a full feature build.',
  'What would you like to ship today?',
];

export default function ChatInput(props: ChatInputProps) {
  const {
    input, setInput, balance, walletBalance, thinking, selectedMode,
    activeProject, talkMode, noBalance,
    imagePreview, setImagePreview, inputRef,
    inputHistoryIndex, messages, sendMessage, toggleTalkMode, wsSend, addMessage,
    isListening, onVoiceToggle, autoExecute, toggleAutoExecute,
  } = props;

  const attachRef = useRef<HTMLInputElement>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [terminalCmd, setTerminalCmd] = useState('');
  const [placeholderIdx] = useState(() => Math.floor(Math.random() * PLACEHOLDERS.length));
  const termInputRef = useRef<HTMLInputElement>(null);

  function runTerminalCommand() {
    const cmd = terminalCmd.trim();
    if (!cmd) return;
    setInput(prev => {
      const suffix = prev ? '\n' : '';
      return `${suffix}run shell command: ${cmd}`;
    });
    setTerminalCmd('');
    setShowTerminal(false);
    setTimeout(() => sendMessage(), 50);
  }

  return (
    <div className="chat-input-area" style={{
      padding: '12px 20px 16px',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      gap: 10,
      alignItems: 'flex-end',
    }}>
      <>
        {balance <= 0 && walletBalance <= 0 && !thinking && (
          <div style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: 'var(--radius-sm)',
            background: 'rgba(255,107,107,0.10)',
            border: '1px solid rgba(255,107,107,0.55)',
            color: 'rgba(255,107,107,0.95)',
            fontSize: 12,
            textAlign: 'center',
            marginBottom: 6,
            boxShadow: '0 0 0 1px rgba(255,107,107,0.08) inset',
          }}>
            Main credits are empty. Free talk mode stays on, and paid modes are locked until you top up.
          </div>
        )}
        {/* Inline terminal input — toggled by the Terminal button */}
        {showTerminal && (
          <div style={{
            display: 'flex', gap: 6, alignItems: 'center',
            width: '100%', marginBottom: 6,
            padding: '4px 8px',
            background: 'var(--bg-secondary)',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--accent)',
          }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', whiteSpace: 'nowrap', fontFamily: 'JetBrains Mono, monospace' }}>$</span>
            <input
              ref={termInputRef}
              type="text"
              value={terminalCmd}
              onChange={e => setTerminalCmd(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); runTerminalCommand(); }
                if (e.key === 'Escape') { setShowTerminal(false); setTerminalCmd(''); }
              }}
              placeholder="Type a shell command... e.g. ls -la"
              style={{
                flex: 1, border: 'none', outline: 'none',
                background: 'transparent', fontSize: 12,
                fontFamily: 'JetBrains Mono, monospace',
                color: 'var(--text-primary)',
              }}
              autoFocus
            />
            <button
              className="btn btn-sm btn-primary"
              onClick={runTerminalCommand}
              disabled={!terminalCmd.trim()}
              style={{ fontSize: 10, padding: '3px 8px', whiteSpace: 'nowrap' }}
              title="Run command"
            >
              <Terminal size={11} style={{ marginRight: 4 }} />
              Run
            </button>
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => { setShowTerminal(false); setTerminalCmd(''); }}
              style={{ fontSize: 10, padding: '3px 6px' }}
              title="Close terminal"
            >
              ✕
            </button>
          </div>
        )}
        {/* Image preview above textarea */}
        {imagePreview && (
          <div style={{
            position: 'relative', display: 'inline-block',
            marginBottom: 6, borderRadius: 8, overflow: 'hidden',
            border: '1px solid var(--border)',
          }}>
            <img src={imagePreview} alt="Preview" style={{ maxHeight: 100, maxWidth: 200, display: 'block' }} />
            <button
              onClick={() => setImagePreview(null)}
              style={{
                position: 'absolute', top: 2, right: 2,
                background: 'rgba(0,0,0,0.6)', border: 'none',
                borderRadius: '50%', width: 20, height: 20,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', color: '#fff', fontSize: 12, lineHeight: 1,
              }}
              title="Remove image"
            >×</button>
          </div>
        )}
        {/* Single unified file input — images, PDFs, DOCX, and code/text files */}
        <input
          ref={attachRef}
          type="file"
          accept="image/*,.pdf,.docx,.doc,.js,.ts,.tsx,.jsx,.mjs,.cjs,.py,.html,.css,.scss,.json,.jsonc,.md,.txt,.sh,.bash,.env,.yaml,.yml,.toml,.rs,.go,.java,.c,.cpp,.h,.rb,.php,.sql,.xml,.csv"
          style={{ display: 'none' }}
          onChange={async e => {
            const file = e.target.files?.[0];
            if (!file) return;
            e.target.value = '';
            const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
            // Images — pass as vision data
            if (file.type.startsWith('image/')) {
              if (selectedMode === 'free') {
                addMessage('system', '📷 Image analysis requires 🚀 Fast or 🧠 Pro mode.');
                return;
              }
              if (file.size > 10 * 1024 * 1024) {
                addMessage('system', '⚠️ Image is too large (max 10 MB). Please resize and try again.');
                return;
              }
              const reader = new FileReader();
              reader.onload = () => setImagePreview(reader.result as string);
              reader.readAsDataURL(file);
              return;
            }
            // PDF / DOCX — server-side text extraction
            if (ext === 'pdf' || ext === 'docx' || ext === 'doc') {
              if (file.size > 20 * 1024 * 1024) {
                addMessage('system', '⚠️ Document is too large (max 20 MB).');
                return;
              }
              addMessage('system', `📄 Parsing **${file.name}**...`);
              try {
                const fd = new FormData();
                fd.append('file', file);
                const res = await fetch('/api/parse-file', { method: 'POST', credentials: 'include', body: fd });
                if (!res.ok) { const err = await res.json().catch(() => ({})); addMessage('system', `⚠️ Could not parse file: ${err.error ?? res.statusText}`); return; }
                const data = await res.json() as { text: string; wordCount: number; pageCount: number | null; truncated: boolean; filename: string };
                const meta = [data.pageCount ? `${data.pageCount} pages` : null, `${data.wordCount.toLocaleString()} words`, data.truncated ? 'truncated to 40k chars' : null].filter(Boolean).join(', ');
                const block = `\n📄 **${data.filename}** (${meta}):\n\`\`\`\n${data.text}\n\`\`\``;
                setInput(prev => prev + block);
                inputRef.current?.focus();
              } catch {
                addMessage('system', '⚠️ Failed to parse document. Please try again.');
              }
              return;
            }
            // Plain text / code files
            if (file.size > 500 * 1024) {
              addMessage('system', '⚠️ File is too large for inline upload (max 500 KB). Use file pinning instead.');
              return;
            }
            const reader = new FileReader();
            reader.onload = () => {
              const content = reader.result as string;
              const block = `\n\`\`\`${ext || 'text'}\n// ${file.name}\n${content}\n\`\`\``;
              setInput(prev => prev + block);
              inputRef.current?.focus();
            };
            reader.readAsText(file);
          }}
        />
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => { setInput(e.target.value); inputHistoryIndex.current = -1; }}
          placeholder={PLACEHOLDERS[placeholderIdx]}
          rows={2}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onPaste={e => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of Array.from(items)) {
              if (item.type.startsWith('image/')) {
                if (selectedMode === 'free') {
                  e.preventDefault();
                  addMessage('system', '📷 Image analysis requires 🚀 Fast or 🧠 Pro mode. Switch to a higher tier to analyze images.');
                  break;
                }
                e.preventDefault();
                const file = item.getAsFile();
                if (!file) continue;
                if (file.size > 10 * 1024 * 1024) {
                  addMessage('system', '⚠️ Image is too large (max 10 MB). Please resize and try again.');
                  continue;
                }
                const reader = new FileReader();
                reader.onload = () => {
                  setImagePreview(reader.result as string);
                };
                reader.readAsDataURL(file);
                break;
              }
            }
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); return; }
            if (e.key === 'ArrowUp' && !e.shiftKey) {
              const userMsgs = messages.filter(m => m.type === 'user').map(m => m.content);
              if (userMsgs.length === 0) return;
              // Only intercept if cursor is on the first line (or field is empty)
              const ta = e.currentTarget;
              const onFirstLine = ta.selectionStart === 0 || !ta.value.slice(0, ta.selectionStart).includes('\n');
              if (!onFirstLine) return;
              e.preventDefault();
              const next = Math.min(inputHistoryIndex.current + 1, userMsgs.length - 1);
              inputHistoryIndex.current = next;
              setInput(userMsgs[userMsgs.length - 1 - next]);
              return;
            }
            if (e.key === 'ArrowDown' && !e.shiftKey && inputHistoryIndex.current >= 0) {
              const userMsgs = messages.filter(m => m.type === 'user').map(m => m.content);
              e.preventDefault();
              const next = inputHistoryIndex.current - 1;
              if (next < 0) { inputHistoryIndex.current = -1; setInput(''); }
              else { inputHistoryIndex.current = next; setInput(userMsgs[userMsgs.length - 1 - next]); }
              return;
            }
          }}
          style={{ flex: 1, resize: 'none', maxHeight: 120 }}
        />
        {/* Unified attach button — images, PDFs, DOCX, code & text files */}
        <button
          className="btn btn-icon btn-secondary"
          onClick={() => attachRef.current?.click()}
          title="Attach file — images, PDF, Word, or code/text files"
          style={{
            alignSelf: 'flex-end',
            padding: '10px 12px',
            background: imagePreview ? 'rgba(108,99,255,0.12)' : 'transparent',
            border: imagePreview ? '1px solid var(--accent)' : '1px solid var(--border)',
            color: imagePreview ? 'var(--accent)' : 'var(--text-muted)',
            transition: 'all 0.15s',
          }}
        >
          <Paperclip size={15} />
        </button>
        {/* Auto-Execute toggle pill */}
        {toggleAutoExecute && (
          <button
            className="btn btn-icon btn-secondary"
            onClick={toggleAutoExecute}
            title={autoExecute ? 'Auto-Execute ON - SUNy will run commands and edits automatically' : 'Auto-Execute OFF - SUNy will ask for permission before running commands or edits'}
            style={{
              alignSelf: 'flex-end',
              padding: '10px 12px',
              background: autoExecute ? 'rgba(34,197,94,0.12)' : 'transparent',
              border: autoExecute ? '1px solid rgba(34,197,94,0.5)' : '1px solid var(--border)',
              color: autoExecute ? 'var(--success,#22c55e)' : 'var(--text-muted)',
              transition: 'all 0.15s',
              fontWeight: 700,
              fontSize: 11,
              letterSpacing: '0.5px'
            }}
          >
            AUTO
          </button>
        )}
        {/* Talk / Write mode toggle — hidden when free plan enforced by no balance */}
        {!noBalance && (
          <button
            className="btn btn-icon btn-secondary"
            onClick={() => {
              if (!talkMode && thinking) {
                if (window.confirm("Switching to Talk mode will interrupt the current task. Continue?")) {
                  wsSend({ type: 'chat:cancel', requestId: '' });
                  toggleTalkMode();
                }
              } else {
                toggleTalkMode();
              }
            }}
            title={talkMode ? 'Talk Mode - no file changes (click to switch to Write Mode)' : 'Write Mode - full file editing (click to switch to Talk Mode)'}
            style={{
              alignSelf: 'flex-end',
              padding: '10px 12px',
              background: talkMode ? 'rgba(108,99,255,0.12)' : 'transparent',
              border: talkMode ? '1px solid var(--accent)' : '1px solid var(--border)',
              color: talkMode ? 'var(--accent)' : 'var(--text-muted)',
              transition: 'all 0.15s',
            }}
          >
            {talkMode ? <MessageSquare size={15} /> : <Pencil size={15} />}
          </button>
        )}
        {onVoiceToggle && (
          <button
            className="btn btn-icon btn-secondary"
            onClick={onVoiceToggle}
            title={isListening ? 'Stop listening' : 'Dictate with voice'}
            style={{
              alignSelf: 'flex-end',
              padding: '10px 12px',
              background: isListening ? 'rgba(255,60,60,0.12)' : 'transparent',
              border: isListening ? '1px solid rgba(255,60,60,0.5)' : '1px solid var(--border)',
              color: isListening ? 'rgba(255,80,80,0.9)' : 'var(--text-muted)',
              transition: 'all 0.15s',
              animation: isListening ? 'pulse 1.2s infinite' : 'none',
            }}
          >
            {isListening ? <MicOff size={15} /> : <Mic size={15} />}
          </button>
        )}
        {thinking ? (
          <button
            className="btn btn-danger"
            onClick={() => wsSend({ type: 'chat:cancel', requestId: '' })}
            style={{ padding: '10px 16px', alignSelf: 'flex-end', minWidth: 48 }}
            title="Stop responding (Esc)"
          >
            <Square size={15} />
          </button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={sendMessage}
            disabled={!input.trim()}
            style={{ padding: '10px 16px', alignSelf: 'flex-end' }}
          >
            <Send size={15} />
          </button>
        )}
      </>
    </div>
  );
}
