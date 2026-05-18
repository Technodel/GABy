import { useState, useEffect } from 'react';
import SunyAvatar from './SunyAvatar';

interface NarratedMessageProps {
  message: string;
  type: 'user' | 'gaby' | 'system';
}

// Renders only narrator-translated friendly messages — never raw technical output
export default function NarratedMessage({ message, type }: NarratedMessageProps) {
  if (type === 'user') {
    return <UserMessage message={message} />;
  }

  if (type === 'system') {
    return <SystemMessage message={message} />;
  }

  return <GabyMessage message={message} />;
}

function UserMessage({ message }: { message: string }) {
  return (
    <div className="message-appear" style={userContainerStyle}>
      <div style={userBubbleStyle}>
        {message}
      </div>
    </div>
  );
}

function SystemMessage({ message }: { message: string }) {
  return (
    <div className="message-appear" style={systemContainerStyle}>
      <span style={systemTextStyle}>{message}</span>
    </div>
  );
}

function GabyMessage({ message }: { message: string }) {
  return (
    <div className="message-appear" style={gabyContainerStyle}>
      <SunyAvatar size={28} />
      <div style={gabyBubbleStyle}>
        <FormattedContent content={message} />
      </div>
    </div>
  );
}

// ── Code block rendering ───────────────────────────────────────────────────────

function FormattedContent({ content }: { content: string }) {
  // Split into segments: text, code blocks, inline code
  const segments = parseContent(content);

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'code-block') {
          return <CodeBlock key={i} code={seg.content} language={seg.language} />;
        }
        if (seg.type === 'inline-code') {
          return <InlineCode key={i} code={seg.content} />;
        }
        return <TextBlock key={i} text={seg.content} />;
      })}
    </>
  );
}

interface Segment {
  type: 'text' | 'code-block' | 'inline-code';
  content: string;
  language?: string;
}

function parseContent(content: string): Segment[] {
  const segments: Segment[] = [];
  // Regex matches fenced code blocks first, then inline code
  const regex = /```(\w*)\n?([\s\S]*?)```|`([^`]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    // Text before this match
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: content.slice(lastIndex, match.index) });
    }

    if (match[1] !== undefined) {
      // Code block: match[1] = language, match[2] = code
      segments.push({ type: 'code-block', content: match[2].trimEnd(), language: match[1] || undefined });
    } else {
      // Inline code
      segments.push({ type: 'inline-code', content: match[3] });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < content.length) {
    segments.push({ type: 'text', content: content.slice(lastIndex) });
  }

  return segments;
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may not be available */ }
  };

  return (
    <div style={codeBlockWrapperStyle}>
      <div style={codeBlockHeaderStyle}>
        <span style={codeLangStyle}>{language || 'code'}</span>
        <button
          onClick={handleCopy}
          style={copyBtnStyle}
          onMouseEnter={e => { (e.target as HTMLElement).style.background = 'rgba(255,255,255,0.1)'; }}
          onMouseLeave={e => { (e.target as HTMLElement).style.background = 'transparent'; }}
        >
          {copied ? '✓ Copied' : '📋 Copy'}
        </button>
      </div>
      <pre style={codeBlockPreStyle}>
        <code style={codeBlockCodeStyle}>
          {code}
        </code>
      </pre>
    </div>
  );
}

function InlineCode({ code }: { code: string }) {
  return (
    <code style={inlineCodeStyle}>{code}</code>
  );
}

function TextBlock({ text }: { text: string }) {
  // Render plain text with line breaks
  return (
    <span style={textStyle}>
      {text.split('\n').map((line, i, arr) => (
        <span key={i}>
          {line}
          {i < arr.length - 1 && <br />}
        </span>
      ))}
    </span>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const userContainerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  marginBottom: 12,
};

const userBubbleStyle: React.CSSProperties = {
  maxWidth: '70%',
  padding: '10px 14px',
  borderRadius: '16px 16px 4px 16px',
  background: 'var(--accent)',
  color: '#fff',
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const systemContainerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  marginBottom: 8,
};

const systemTextStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-muted)',
  fontStyle: 'italic',
};

const gabyContainerStyle: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  marginBottom: 12,
  alignItems: 'flex-start',
};

const gabyBubbleStyle: React.CSSProperties = {
  maxWidth: '75%',
  padding: '10px 14px',
  borderRadius: '4px 16px 16px 16px',
  background: 'var(--surface)',
  borderLeft: '3px solid var(--accent)',
  color: 'var(--text-primary)',
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflow: 'hidden',
};

const textStyle: React.CSSProperties = {
  lineHeight: 1.6,
};

const codeBlockWrapperStyle: React.CSSProperties = {
  margin: '8px 0',
  borderRadius: 8,
  overflow: 'hidden',
  border: '1px solid rgba(255,255,255,0.08)',
};

const codeBlockHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '6px 12px',
  background: 'rgba(255,255,255,0.04)',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
};

const codeLangStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const copyBtnStyle: React.CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  transition: 'background 0.15s',
};

const codeBlockPreStyle: React.CSSProperties = {
  margin: 0,
  padding: '12px 16px',
  background: '#0D1117',
  overflow: 'auto',
  maxHeight: 400,
};

const codeBlockCodeStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  fontSize: 13,
  lineHeight: 1.5,
  color: '#E6EDF3',
  whiteSpace: 'pre',
  tabSize: 2,
};

const inlineCodeStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  fontSize: 13,
  padding: '1px 5px',
  borderRadius: 4,
  background: 'rgba(108,99,255,0.12)',
  color: 'var(--accent)',
  wordBreak: 'break-word',
};

// ── Thinking indicator ─────────────────────────────────────────────────────────

const THINKING_PHRASES = [
  'Reading your project files…',
  'Thinking through this carefully…',
  'Checking the codebase…',
  'Analysing the structure…',
  'Putting it all together…',
  'Reviewing relevant files…',
  'Working on it…',
  'Almost there…',
  'Making improvements…',
  'Running the steps…',
];

export function ThinkingIndicator({ statusText }: { statusText?: string }) {
  const [phraseIdx, setPhraseIdx] = useState(0);

  useEffect(() => {
    if (statusText) return; // Don't cycle when a live status is shown
    const timer = setInterval(() => {
      setPhraseIdx(i => (i + 1) % THINKING_PHRASES.length);
    }, 2200);
    return () => clearInterval(timer);
  }, [statusText]);

  return (
    <div style={thinkingContainerStyle}>
      <SunyAvatar size={28} />
      <div style={thinkingBubbleStyle}>
        <span style={dotContainerStyle}>
          {[1, 2, 3].map(i => (
            <span key={i} className={`dot-${i}`} style={dotStyle} />
          ))}
        </span>
        {statusText || THINKING_PHRASES[phraseIdx]}
      </div>
    </div>
  );
}

const thinkingContainerStyle: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'center',
  marginBottom: 12,
};

const thinkingBubbleStyle: React.CSSProperties = {
  padding: '10px 16px',
  borderRadius: '4px 16px 16px 16px',
  background: 'var(--surface)',
  borderLeft: '3px solid var(--accent)',
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  color: 'var(--text-secondary)',
  fontSize: 13,
  fontStyle: 'italic',
};

const dotContainerStyle: React.CSSProperties = {
  display: 'inline-flex',
  gap: 4,
  alignItems: 'center',
};

const dotStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 5,
  height: 5,
  borderRadius: '50%',
  background: 'var(--accent)',
  opacity: 0.7,
};
