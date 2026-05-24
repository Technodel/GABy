import { Send, Square, Image, MessageSquare, Pencil, Mic, MicOff, FileCode } from 'lucide-react';
import { useRef } from 'react';
import type { Message } from '../types';

interface ChatInputProps {
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  balance: number;
  walletBalance: number;
  thinking: boolean;
  selectedMode: string;
  activeProject: { id: number; name: string; local_path: string; persona?: string | null } | null;
  bridgeConnected: boolean;
  talkMode: boolean;
  noBalance: boolean;
  imagePreview: string | null;
  setImagePreview: React.Dispatch<React.SetStateAction<string | null>>;
  fileInputRef: React.RefObject<HTMLInputElement>;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  inputHistoryIndex: React.MutableRefObject<number>;
  messages: Message[];
  sendMessage: () => void;
  toggleTalkMode: () => void;
  wsSend: (msg: Record<string, unknown>) => void;
  addMessage: (type: 'user' | 'suny' | 'system', content: string, extra?: Record<string, unknown>) => void;
  isListening?: boolean;
  onVoiceToggle?: () => void;
}

export default function ChatInput(props: ChatInputProps) {
  const {
    input, setInput, balance, walletBalance, thinking, selectedMode,
    activeProject, bridgeConnected, talkMode, noBalance,
    imagePreview, setImagePreview, fileInputRef, inputRef,
    inputHistoryIndex, messages, sendMessage, toggleTalkMode, wsSend, addMessage,
    isListening, onVoiceToggle,
  } = props;

  const codeFileRef = useRef<HTMLInputElement>(null);

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
        <input
          ref={codeFileRef}
          type="file"
          accept=".js,.ts,.tsx,.jsx,.mjs,.cjs,.py,.html,.css,.scss,.json,.jsonc,.md,.txt,.sh,.bash,.env,.yaml,.yml,.toml,.rs,.go,.java,.c,.cpp,.h,.rb,.php,.sql,.xml,.csv"
          style={{ display: 'none' }}
          onChange={e => {
            const file = e.target.files?.[0];
            if (!file) return;
            if (file.size > 500 * 1024) {
              addMessage('system', '⚠️ File is too large for inline upload (max 500 KB). Use file pinning instead.');
              e.target.value = '';
              return;
            }
            const ext = file.name.split('.').pop() ?? 'text';
            const reader = new FileReader();
            reader.onload = () => {
              const content = reader.result as string;
              const block = `\n\`\`\`${ext}\n// ${file.name}\n${content}\n\`\`\``;
              setInput(prev => prev + block);
              inputRef.current?.focus();
            };
            reader.readAsText(file);
            e.target.value = '';
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={e => {
            const file = e.target.files?.[0];
            if (!file) return;
            if (selectedMode === 'free') {
              addMessage('system', '📷 Image analysis requires 🚀 Fast or 🧠 Pro mode. Switch to a higher tier to analyze images.');
              e.target.value = '';
              return;
            }
            if (file.size > 10 * 1024 * 1024) {
              addMessage('system', '⚠️ Image is too large (max 10 MB). Please resize and try again.');
              e.target.value = '';
              return;
            }
            const reader = new FileReader();
            reader.onload = () => {
              setImagePreview(reader.result as string);
            };
            reader.readAsDataURL(file);
            // Reset so same file can be selected again
            e.target.value = '';
          }}
        />
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => { setInput(e.target.value); inputHistoryIndex.current = -1; }}
          placeholder={thinking ? 'SUNy is working...' : activeProject && !bridgeConnected ? 'Bridge offline — I can still reason, explain, and review code! Type your question...' : 'Type your goal here... e.g. Add a dark mode toggle to my app'}
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
            if (e.key === 'Enter' && !e.shiftKey && !thinking) { e.preventDefault(); sendMessage(); return; }
            if (e.key === 'ArrowUp' && !e.shiftKey && !thinking) {
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
            if (e.key === 'ArrowDown' && !e.shiftKey && !thinking && inputHistoryIndex.current >= 0) {
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
        {/* Code file upload button */}
        <button
          className="btn btn-icon btn-secondary"
          onClick={() => codeFileRef.current?.click()}
          title="Attach a code or text file — content will be pasted as a code block"
          style={{
            alignSelf: 'flex-end',
            padding: '10px 12px',
            background: 'transparent',
            border: '1px solid var(--border)',
            color: 'var(--text-muted)',
            transition: 'all 0.15s',
          }}
        >
          <FileCode size={15} />
        </button>
        {/* Image upload button */}
        <button
          className="btn btn-icon btn-secondary"
          onClick={() => fileInputRef.current?.click()}
          disabled={selectedMode === 'free'}
          title={selectedMode === 'free' ? 'Image analysis requires Fast or Pro mode' : 'Attach an image for analysis'}
          style={{
            alignSelf: 'flex-end',
            padding: '10px 12px',
            background: imagePreview ? 'rgba(108,99,255,0.12)' : 'transparent',
            border: imagePreview ? '1px solid var(--accent)' : '1px solid var(--border)',
            color: imagePreview ? 'var(--accent)' : 'var(--text-muted)',
            transition: 'all 0.15s',
          }}
        >
          <Image size={15} />
        </button>
        {/* Talk / Write mode toggle — hidden when free plan enforced by no balance */}
        {!noBalance && (
          <button
            className="btn btn-icon btn-secondary"
            onClick={toggleTalkMode}
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
        {thinking ? (
          <button
            className="btn btn-danger"
            onClick={() => wsSend({ type: 'chat:cancel', requestId: '' })}
            style={{ padding: '10px 16px', alignSelf: 'flex-end' }}
            title="Stop responding"
          >
            <Square size={15} />
          </button>
        ) : (
          <>
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
            <button
              className="btn btn-primary"
              onClick={sendMessage}
              disabled={!input.trim()}
              style={{ padding: '10px 16px', alignSelf: 'flex-end' }}
            >
              <Send size={15} />
            </button>
          </>
        )}
      </>
    </div>
  );
}
