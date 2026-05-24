import { useState, useEffect, useRef } from 'react';
import { Copy, ChevronRight, ChevronDown, Code, Image as ImageIcon, X } from 'lucide-react';
import SunyAvatar from './SunyAvatar';
import ReportBadgeButton, { ReportMetrics } from './ReportBadgeButton';

interface NarratedMessageProps {
  message: string;
  type: 'user' | 'suny' | 'system';
  isActive?: boolean;
  timestamp?: number;
  report?: ReportMetrics;
  imageData?: string;
}

// Renders only narrator-translated friendly messages — never raw technical output
export default function NarratedMessage({ message, type, isActive = false, timestamp = Date.now(), report, imageData }: NarratedMessageProps) {
  if (type === 'user') {
    return <UserMessage message={message} timestamp={timestamp} imageData={imageData} />;
  }

  if (type === 'system') {
    return <SystemMessage message={message} timestamp={timestamp} />;
  }

  return <SunyMessage message={message} isActive={isActive} timestamp={timestamp} report={report} />;
}

function UserMessage({ message, timestamp, imageData }: { message: string; timestamp: number; imageData?: string }) {
  const [showImagePreview, setShowImagePreview] = useState(false);

  return (
    <div className="message-appear" style={userContainerStyle}>
      <div style={userWrapStyle}>
        <div style={userBubbleStyle}>
          {message}
          {imageData && (
            <div style={{ marginTop: 8, display: 'inline-block' }}>
              <button
                onClick={() => setShowImagePreview(true)}
                style={{
                  background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: 6, padding: '4px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                  color: '#fff', fontSize: 12
                }}
              >
                <ImageIcon size={14} /> Attached Image
              </button>
            </div>
          )}
        </div>
        <div style={userMetaStyle}>Sent {formatDateTime(timestamp)}</div>
      </div>
      
      {showImagePreview && imageData && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.85)', zIndex: 99999,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: 40
        }}>
          <button 
            onClick={() => setShowImagePreview(false)}
            style={{ position: 'absolute', top: 20, right: 20, background: 'none', border: 'none', color: '#fff', cursor: 'pointer' }}
          ><X size={32} /></button>
          <img src={imageData} alt="Attachment Preview" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }} />
        </div>
      )}
    </div>
  );
}

function SystemMessage({ message, timestamp }: { message: string; timestamp: number }) {
  return (
    <div className="message-appear" style={systemContainerStyle}>
      <div style={{ textAlign: 'center' }}>
        <span style={systemTextStyle}>{message}</span>
        <div style={systemMetaStyle}>{formatDateTime(timestamp)}</div>
      </div>
    </div>
  );
}

function SunyMessage({ message, isActive = false, timestamp, report }: { message: string; isActive?: boolean; timestamp: number; report?: ReportMetrics }) {
  const visualEffects = (() => { try { return localStorage.getItem('suny_visual_effects') !== 'false'; } catch { return true; } })();
  const [copied, setCopied] = useState(false);

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may not be available */ }
  }

  return (
    <div className="message-appear" style={sunyContainerStyle}>
      <SunyAvatar size={28} />
      <div className={isActive && visualEffects ? 'suny-bubble-led' : undefined} style={{ ...sunyBubbleStyle, position: 'relative' }}>
        <div className={isActive && visualEffects ? 'suny-bubble-active' : undefined}>
          <FormattedContent content={message} />
        </div>
        <div style={sunyMetaRowStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={sunyMetaStyle}>Received {formatDateTime(timestamp)}</span>
            <button
              onClick={copyMessage}
              title="Copy SUNy response"
              aria-label="Copy SUNy response"
              style={messageCopyBtnStyle}
            >
              <Copy size={11} />
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          {report && <ReportBadgeButton report={report} label="Task report" />}
        </div>
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
  const [expanded, setExpanded] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may not be available */ }
  };

  return (
    <div style={codeBlockWrapperStyle}>
      <div 
        style={{ ...codeBlockHeaderStyle, cursor: 'pointer' }}
        onClick={() => setExpanded(!expanded)}
        title={expanded ? 'Click to collapse' : 'Click to view code'}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Code size={14} />
          <span style={codeLangStyle}>{language ? `${language} snippet` : 'Code snippet'}</span>
        </div>
        <div>
          {expanded && (
            <button
              onClick={handleCopy}
              style={copyBtnStyle}
              onMouseEnter={e => { (e.target as HTMLElement).style.background = 'rgba(255,255,255,0.1)'; }}
              onMouseLeave={e => { (e.target as HTMLElement).style.background = 'transparent'; }}
            >
              {copied ? '✓ Copied' : '📋 Copy'}
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <pre style={codeBlockPreStyle}>
          <code style={codeBlockCodeStyle}>
            {code}
          </code>
        </pre>
      )}
    </div>
  );
}

function InlineCode({ code }: { code: string }) {
  return (
    <code style={inlineCodeStyle}>{code}</code>
  );
}

function TextBlock({ text }: { text: string }) {
  const blocks = buildTextBlocks(text);

  return (
    <div style={textBlockContainerStyle}>
      {blocks.map((block, blockIndex) => {
        if (block.type === 'unordered-list') {
          return (
            <ul key={blockIndex} style={unorderedListStyle}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} style={listItemStyle}>
                  {renderInlineText(item, `${blockIndex}-${itemIndex}`)}
                </li>
              ))}
            </ul>
          );
        }

        if (block.type === 'ordered-list') {
          return (
            <ol key={blockIndex} style={orderedListStyle}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} style={listItemStyle}>
                  {renderInlineText(item, `${blockIndex}-${itemIndex}`)}
                </li>
              ))}
            </ol>
          );
        }

        if (block.type === 'table') {
          return (
            <div key={blockIndex} style={tableScrollStyle}>
              <table style={tableStyle}>
                {block.header.length > 0 && (
                  <thead>
                    <tr>
                      {block.header.map((cell, cellIndex) => (
                        <th key={cellIndex} style={tableThStyle}>
                          {renderInlineText(cell, `${blockIndex}-h-${cellIndex}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                )}
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} style={tableTdStyle}>
                          {renderInlineText(cell, `${blockIndex}-${rowIndex}-${cellIndex}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        return (
          <p key={blockIndex} style={paragraphStyle}>
            {renderInlineText(block.text, `${blockIndex}`)}
          </p>
        );
      })}
    </div>
  );
}

type TextBlockNode =
  | { type: 'paragraph'; text: string }
  | { type: 'unordered-list'; items: string[] }
  | { type: 'ordered-list'; items: string[] }
  | { type: 'table'; header: string[]; rows: string[][] };

function parseTableRow(line: string): string[] {
  // Strip leading/trailing pipes, then split on remaining pipes.
  let inner = line.trim();
  if (inner.startsWith('|')) inner = inner.slice(1);
  if (inner.endsWith('|')) inner = inner.slice(0, -1);
  return inner.split('|').map(c => c.trim());
}

function isTableSeparator(line: string): boolean {
  // e.g. | --- | :---: | ---: | --- |
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') && !trimmed.includes('|')) return false;
  const cells = parseTableRow(trimmed);
  if (cells.length === 0) return false;
  return cells.every(c => /^:?-{3,}:?$/.test(c));
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.includes('|', 1);
}

function buildTextBlocks(text: string): TextBlockNode[] {
  const normalized = normalizeDisplayText(text);
  const lines = normalized.split('\n');
  const blocks: TextBlockNode[] = [];
  let paragraphLines: string[] = [];
  let unorderedItems: string[] = [];
  let orderedItems: string[] = [];

  const flushParagraph = () => {
    const value = paragraphLines.join(' ').trim();
    if (value) blocks.push({ type: 'paragraph', text: value });
    paragraphLines = [];
  };

  const flushUnordered = () => {
    if (unorderedItems.length > 0) blocks.push({ type: 'unordered-list', items: unorderedItems });
    unorderedItems = [];
  };

  const flushOrdered = () => {
    if (orderedItems.length > 0) blocks.push({ type: 'ordered-list', items: orderedItems });
    orderedItems = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      flushUnordered();
      flushOrdered();
      continue;
    }

    // ── Table detection ──────────────────────────────────────────
    // A table needs: header row (|..|..|), separator row (|---|---|),
    // then one or more body rows.
    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      flushParagraph();
      flushUnordered();
      flushOrdered();
      const header = parseTableRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j].trim())) {
        rows.push(parseTableRow(lines[j].trim()));
        j++;
      }
      blocks.push({ type: 'table', header, rows });
      i = j - 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      flushOrdered();
      unorderedItems.push(line.replace(/^[-*]\s+/, '').trim());
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      flushParagraph();
      flushUnordered();
      orderedItems.push(line.replace(/^\d+\.\s+/, '').trim());
      continue;
    }

    flushUnordered();
    flushOrdered();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushUnordered();
  flushOrdered();

  return blocks;
}

function normalizeDisplayText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/([^\n\s])\s*-\s+(?=(\*\*|[A-Z0-9]))/g, '$1\n- ')
    .replace(/([^\n\s])-\s+(?=(\*\*|[A-Z0-9]))/g, '$1\n- ');
}

function renderInlineText(text: string, keyPrefix: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /\*\*([^*]+)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <strong key={`${keyPrefix}-${match.index}`} style={boldTextStyle}>
        {match[1]}
      </strong>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
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
  color: 'var(--bg)',
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontWeight: 500,
};

const userWrapStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 4,
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

const systemMetaStyle: React.CSSProperties = {
  marginTop: 3,
  fontSize: 10,
  color: 'var(--text-muted)',
  textAlign: 'center',
};

const sunyContainerStyle: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  marginBottom: 12,
  alignItems: 'flex-start',
};

const sunyBubbleStyle: React.CSSProperties = {
  maxWidth: '75%',
  padding: '10px 14px',
  borderRadius: '4px 16px 16px 16px',
  background: 'var(--surface)',
  borderLeft: '3px solid var(--accent)',
  color: 'var(--text-primary)',
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const sunyMetaRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  marginTop: 8,
};

const sunyMetaStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--text-muted)',
};

const userMetaStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--text-muted)',
  textAlign: 'right',
};

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

const textStyle: React.CSSProperties = {
  lineHeight: 1.6,
};

const textBlockContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const paragraphStyle: React.CSSProperties = {
  ...textStyle,
  margin: 0,
};

const unorderedListStyle: React.CSSProperties = {
  ...textStyle,
  margin: 0,
  paddingLeft: 20,
};

const orderedListStyle: React.CSSProperties = {
  ...textStyle,
  margin: 0,
  paddingLeft: 20,
};

const listItemStyle: React.CSSProperties = {
  margin: '0 0 4px',
};

const tableScrollStyle: React.CSSProperties = {
  margin: '4px 0',
  overflowX: 'auto',
  borderRadius: 8,
  border: '1px solid var(--border)',
};

const tableStyle: React.CSSProperties = {
  ...textStyle,
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
};

const tableThStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  background: 'rgba(255,255,255,0.04)',
  borderBottom: '1px solid var(--border)',
  fontWeight: 600,
  color: 'var(--text-primary)',
  whiteSpace: 'nowrap',
};

const tableTdStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'top',
  color: 'var(--text-primary)',
};

const boldTextStyle: React.CSSProperties = {
  fontWeight: 700,
  color: 'var(--text-primary)',
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

const messageCopyBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 10,
  padding: '2px 6px',
  borderRadius: 4,
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  lineHeight: 1.2,
  flexShrink: 0,
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
  'Working on your request…',
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
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    const tick = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (statusText) return; // Don't cycle when a live status is shown
    const timer = setInterval(() => {
      setPhraseIdx(i => (i + 1) % THINKING_PHRASES.length);
    }, 2200);
    return () => clearInterval(timer);
  }, [statusText]);

  const elapsedLabel = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
    : `${elapsed}s`;

  return (
    <div className="message-appear" style={thinkingContainerStyle}>
      <SunyAvatar size={28} />
      <div className={statusText ? undefined : 'suny-bubble-led'} style={thinkingBubbleStyle}>
        <span style={dotContainerStyle}>
          {[1, 2, 3].map(i => (
            <span key={i} className={`dot-${i}`} style={dotStyle} />
          ))}
        </span>
        <span style={{ marginLeft: 2 }}>{statusText || THINKING_PHRASES[phraseIdx]}</span>
        {elapsed >= 3 && (
          <span style={{ marginLeft: 8, opacity: 0.55, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
            · {elapsedLabel}
          </span>
        )}
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
