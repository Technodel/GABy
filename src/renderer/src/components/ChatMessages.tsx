import { Eraser, X, FolderOpen, ChevronRight, ChevronDown, Copy, Trash2, Archive, RefreshCw, Edit3 } from 'lucide-react';
import { useState } from 'react';
import NarratedMessage, { ThinkingIndicator } from './NarratedMessage';
import type { Message, ProofRun, Project } from '../types';

interface ChatMessagesProps {
  messages: Message[];
  activeProject: Project | null;
  thinking: boolean;
  streamingContent: string;
  thinkingStatus: string;
  proofRuns: ProofRun[];
  globalTabs: { id: string; name: string; archived?: boolean }[];
  activeTabId: string;
  renamingTabId: string | null;
  renamingTabValue: string;
  deleteConfirmTabId: string | null;
  projectStateReady: boolean;
  globalIntroLine: string;
  projects: Project[];
  bridgeConnected: boolean;
  expandedRunIds: Set<number>;
  msgEndRef: React.RefObject<HTMLDivElement>;
  clearChat: () => void;
  onDeleteMessage?: (id: number) => void;
  onRegenerateMessage?: (id: number) => void;
  onEditMessage?: (id: number) => void;
  setRenamingTabId: React.Dispatch<React.SetStateAction<string | null>>;
  setRenamingTabValue: React.Dispatch<React.SetStateAction<string>>;
  setDeleteConfirmTabId: React.Dispatch<React.SetStateAction<string | null>>;
  switchGlobalTab: (tabId: string) => void;
  closeGlobalTab: (tabId: string) => void;
  addGlobalTab: () => void;
  archiveGlobalTab: (tabId: string) => void;
  deleteArchivedTab: (tabId: string) => void;
  renameGlobalTab: (tabId: string, name: string) => void;
  setShowBridgeTip: React.Dispatch<React.SetStateAction<boolean>>;
  openProject: (project: Project) => void;
  copyProofReportToClipboard: (run: ProofRun) => void;
  setExpandedRunIds: React.Dispatch<React.SetStateAction<Set<number>>>;
  toolLabel: (tool: string) => string;
}

export default function ChatMessages(props: ChatMessagesProps) {
  const {
    messages, activeProject, thinking, streamingContent, thinkingStatus,
    proofRuns, globalTabs, activeTabId, renamingTabId, renamingTabValue,
    deleteConfirmTabId, globalIntroLine, projects, bridgeConnected,
    expandedRunIds, msgEndRef,
    clearChat, onDeleteMessage, onRegenerateMessage, onEditMessage, setRenamingTabId, setRenamingTabValue, setDeleteConfirmTabId,
    switchGlobalTab, closeGlobalTab, addGlobalTab, archiveGlobalTab,
    setShowBridgeTip, openProject, copyProofReportToClipboard, setExpandedRunIds, toolLabel, renameGlobalTab,
  } = props;

  const [hoveredMsgId, setHoveredMsgId] = useState<number | null>(null);
  const [proofPanelCollapsed, setProofPanelCollapsed] = useState(false);
  const activeTabs = globalTabs.filter(t => !t.archived);

  function commitTabRename(tabId: string, fallbackName: string) {
    const next = renamingTabValue.trim();
    renameGlobalTab(tabId, next || fallbackName);
    setRenamingTabId(null);
    setRenamingTabValue('');
  }

  return (
    <div className="chat-messages-area" style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
      {messages.length > 0 && (
        <button
          className="btn btn-icon btn-secondary btn-sm"
          onClick={clearChat}
          title="Clear chat"
          style={{
            position: 'sticky', top: 0, float: 'right', zIndex: 10,
            margin: '0 0 8px 0', opacity: 0.55,
          }}
        >
          <Eraser size={13} />
        </button>
      )}

      {!activeProject && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4, marginBottom: 16, flexWrap: 'wrap',
          position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg)', paddingTop: 4, paddingBottom: 4,
        }}>
          {activeTabs.map(tab => (
            <div
              key={tab.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '4px 10px 4px 12px',
                borderRadius: 20,
                border: `1px solid ${activeTabId === tab.id ? 'var(--accent)' : 'var(--border)'}`,
                background: activeTabId === tab.id ? 'rgba(41,255,122,0.08)' : 'var(--surface)',
                color: activeTabId === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                cursor: 'pointer',
              }}
              onClick={() => switchGlobalTab(tab.id)}
              onDoubleClick={() => {
                setRenamingTabId(tab.id);
                setRenamingTabValue(tab.name);
              }}
            >
              <button
                onClick={e => { e.stopPropagation(); archiveGlobalTab(tab.id); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex', alignItems: 'center', flexShrink: 0 }}
                title="Archive tab"
              >
                <Archive size={10} />
              </button>

              {renamingTabId === tab.id ? (
                <input
                  value={renamingTabValue}
                  onChange={e => setRenamingTabValue(e.target.value)}
                  onBlur={() => commitTabRename(tab.id, tab.name)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitTabRename(tab.id, tab.name);
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setRenamingTabId(null);
                      setRenamingTabValue('');
                    }
                  }}
                  onClick={e => e.stopPropagation()}
                  autoFocus
                  style={{ width: 90, fontSize: 11, padding: '2px 6px' }}
                />
              ) : (
                <span style={{ fontSize: 12, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tab.name}
                </span>
              )}

              {deleteConfirmTabId === tab.id ? (
                <div style={{ display: 'flex', gap: 2, marginLeft: 2 }}>
                  <button
                    onClick={e => { e.stopPropagation(); closeGlobalTab(tab.id); setDeleteConfirmTabId(null); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--error)', padding: 0, display: 'flex', alignItems: 'center', fontSize: 10, lineHeight: 1 }}
                    title="Confirm delete"
                  >
                    <X size={10} />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); setDeleteConfirmTabId(null); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex', alignItems: 'center', fontSize: 10, lineHeight: 1 }}
                    title="Cancel"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 2, flexShrink: 0 }}>
                  <button
                    onClick={e => { e.stopPropagation(); setDeleteConfirmTabId(tab.id); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex', alignItems: 'center' }}
                    title="Delete tab"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              )}
            </div>
          ))}

          <button
            onClick={addGlobalTab}
            style={{
              width: 24, height: 24, borderRadius: '50%',
              border: '1px solid var(--border)', background: 'var(--surface)',
              color: 'var(--text-muted)', cursor: 'pointer', display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              fontSize: 14, lineHeight: 1,
            }}
            title="New chat tab"
          >+</button>
        </div>
      )}

      {!activeProject && messages.length === 0 && !thinking && (
        <div style={{ textAlign: 'center', marginTop: 48, color: 'var(--text-muted)', padding: '0 24px' }}>
          <img src="/SLOGO.png" alt="SUNy" style={{ width: 140, height: 140, borderRadius: '50%', objectFit: 'cover', marginBottom: 14, boxShadow: '0 4px 20px rgba(108,99,255,0.2)' }} />
          <p style={{ fontWeight: 700, fontSize: 22, color: 'var(--text-primary)', marginBottom: 4 }}>SUNy</p>
          <p style={{ fontSize: 14, fontStyle: 'italic', color: 'var(--accent)', marginBottom: 20, opacity: 0.9 }}>Consider it done.</p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 24, lineHeight: 1.6 }}>
            {globalIntroLine || 'Pick a project from the sidebar to start coding.'}
          </p>
          {projects.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 24 }}>
              {projects.map(p => (
                <button
                  key={p.id}
                  className="btn btn-secondary btn-sm"
                  style={{ fontSize: 12, padding: '5px 12px', borderRadius: 20, display: 'flex', alignItems: 'center', gap: 6 }}
                  onClick={() => openProject(p)}
                >
                  <FolderOpen size={12} />
                  {p.name}
                </button>
              ))}
            </div>
          )}
          {projects.length === 0 && (
            <div style={{
              maxWidth: 460, margin: '0 auto 24px', textAlign: 'left',
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 12, padding: '16px 20px',
            }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 }}>
                👋 First time here? Three steps to get coding:
              </p>
              <ol style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7, paddingLeft: 20, margin: 0 }}>
                <li>
                  <strong>Install the Bridge</strong> on your computer so I can read & edit files locally.{' '}
                  <button
                    onClick={() => setShowBridgeTip(true)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: 12, padding: 0, textDecoration: 'underline' }}
                  >Show me how</button>
                </li>
                <li><strong>Register a project</strong> — point the Bridge at any folder on your machine.</li>
                <li><strong>Ask me anything</strong> — "fix this bug", "add a login page", "explain this code". I'll handle the rest.</li>
              </ol>
            </div>
          )}
          {!bridgeConnected && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', opacity: 0.7 }}>
              <button
                onClick={() => setShowBridgeTip(true)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: 12, padding: 0, textDecoration: 'underline' }}
              >
                Connect the Bridge
              </button>{' '}to unlock file editing and shell commands.
            </p>
          )}
        </div>
      )}

      {activeProject && messages.length === 0 && !thinking && (
        <div style={{ textAlign: 'center', marginTop: 40, color: 'var(--text-muted)' }}>
          <img src="/SLOGO.png" alt="SUNy" style={{ width: 'clamp(100px, 14vw, 180px)', height: 'clamp(100px, 14vw, 180px)', borderRadius: '50%', objectFit: 'cover', marginBottom: 14, boxShadow: '0 4px 20px rgba(108,99,255,0.2)' }} />
          <p style={{ fontWeight: 700, fontSize: 22, marginBottom: 6, color: 'var(--text-primary)' }}>Hi! I'm SUNy</p>
          <p style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--accent)', marginBottom: 10, opacity: 0.9 }}>Consider it done.</p>
          <p style={{ fontSize: 14 }}>Tell me what you'd like to build or fix. I'll take it from there!</p>
        </div>
      )}

      {proofRuns.length > 0 && (
        <div style={{
          marginBottom: 12,
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--surface)',
          overflow: 'hidden',
        }}>
          <div
            style={{
              padding: '10px 12px',
              borderBottom: !proofPanelCollapsed && proofRuns.length > 1 ? '1px solid var(--border)' : 'none',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10,
              cursor: 'pointer',
            }}
            onClick={() => setProofPanelCollapsed(v => !v)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {proofPanelCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <strong style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                Proof Panel {proofRuns.length > 1 ? `(${proofRuns.length})` : ''}
              </strong>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {proofRuns[0].status === 'running' ? 'In progress' : proofRuns[0].status === 'completed' ? 'Completed' : 'Needs attention'}
            </div>
          </div>

          {!proofPanelCollapsed && (
            <>
              <div style={{
                padding: '8px 12px',
                borderBottom: proofRuns.length > 1 ? '1px solid var(--border)' : 'none',
                background: 'rgba(108,99,255,0.05)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <strong style={{ fontSize: 11, color: 'var(--accent)' }}>Active Run</strong>
                  {proofRuns[0].status === 'completed' && (
                    <button
                      onClick={() => copyProofReportToClipboard(proofRuns[0])}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)',
                        fontSize: 11, padding: '2px 6px', display: 'flex', alignItems: 'center', gap: 4,
                      }}
                      title="Copy proof report"
                    >
                      <Copy size={11} /> Copy
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  <strong style={{ color: 'var(--text-primary)' }}>Tools:</strong>{' '}
                  {proofRuns[0].toolCalls.length > 0
                    ? proofRuns[0].toolCalls.map(toolLabel).join(' -> ')
                    : 'None yet'}
                </div>
                {proofRuns[0].checks.length > 0 && (
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
                    <strong style={{ color: 'var(--text-primary)' }}>Last checks:</strong> {proofRuns[0].checks.slice(-2).join(' | ')}
                  </div>
                )}
              </div>

              {proofRuns.length > 1 && (
                <div style={{ borderTop: '1px solid var(--border)' }}>
                  <div
                    onClick={() => setExpandedRunIds(prev => {
                      const next = new Set(prev);
                      if (next.has(-1)) next.delete(-1);
                      else next.add(-1);
                      return next;
                    })}
                    style={{
                      padding: '6px 12px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 11,
                      color: 'var(--text-muted)',
                      userSelect: 'none',
                    }}
                  >
                    {expandedRunIds.has(-1) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span>Earlier runs ({proofRuns.length - 1})</span>
                  </div>

                  {expandedRunIds.has(-1) && (
                    <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                      {proofRuns.slice(1).map(run => {
                        const isExpanded = expandedRunIds.has(run.id);
                        const duration = run.durationMs ?? ((run.finishedAt ?? Date.now()) - run.startedAt);
                        const durationSec = (duration / 1000).toFixed(1);
                        return (
                          <div key={run.id} style={{ borderTop: '1px solid var(--border)' }}>
                            <div
                              onClick={() => setExpandedRunIds(prev => {
                                const next = new Set(prev);
                                if (next.has(run.id)) next.delete(run.id);
                                else next.add(run.id);
                                return next;
                              })}
                              style={{
                                padding: '6px 12px',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                fontSize: 10,
                                color: 'var(--text-secondary)',
                                userSelect: 'none',
                              }}
                            >
                              {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                              <span>{new Date(run.startedAt).toLocaleTimeString()}</span>
                              <span>· {durationSec}s</span>
                              <span>· {run.toolCalls.length} tools</span>
                            </div>

                            {isExpanded && (
                              <div style={{ padding: '6px 12px 8px 24px', fontSize: 10, background: 'rgba(0,0,0,0.15)' }}>
                                {run.toolCalls.length > 0 && (
                                  <div style={{ marginBottom: 4, color: 'var(--text-secondary)' }}>
                                    <strong>Tools:</strong> {run.toolCalls.map(toolLabel).join(', ')}
                                  </div>
                                )}
                                {run.filesChanged !== undefined && (
                                  <div style={{ marginBottom: 4, color: 'var(--text-secondary)' }}>
                                    <strong>Files:</strong> {run.filesChanged} changed
                                  </div>
                                )}
                                {run.steps !== undefined && (
                                  <div style={{ marginBottom: 4, color: 'var(--text-secondary)' }}>
                                    <strong>Steps:</strong> {run.steps}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {messages.map(m => (
        <div
          key={m.id}
          style={{ position: 'relative' }}
          onMouseEnter={() => setHoveredMsgId(m.id)}
          onMouseLeave={() => setHoveredMsgId(null)}
        >
          <NarratedMessage message={m.content} type={m.type} timestamp={m.timestamp} report={m.report} />
          {hoveredMsgId === m.id && (
            <div style={{
              position: 'absolute', top: 6, right: 6,
              display: 'flex', gap: 4, alignItems: 'center',
            }}>
              {m.type === 'user' && onEditMessage && !thinking && (
                <button
                  onClick={() => onEditMessage(m.id)}
                  title="Edit & re-send"
                  style={{
                    background: 'rgba(108,99,255,0.12)', border: '1px solid rgba(108,99,255,0.3)',
                    borderRadius: 4, cursor: 'pointer', padding: '2px 5px',
                    display: 'flex', alignItems: 'center', gap: 3,
                    color: 'rgba(140,130,255,0.95)', fontSize: 10,
                  }}
                ><Edit3 size={10} /> edit</button>
              )}
              {m.type === 'user' && onRegenerateMessage && !thinking && (
                <button
                  onClick={() => onRegenerateMessage(m.id)}
                  title="Re-send this message (drops responses after it)"
                  style={{
                    background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)',
                    borderRadius: 4, cursor: 'pointer', padding: '2px 5px',
                    display: 'flex', alignItems: 'center', gap: 3,
                    color: 'rgba(120,220,150,0.95)', fontSize: 10,
                  }}
                ><RefreshCw size={10} /> regenerate</button>
              )}
              {onDeleteMessage && (
                <button
                  onClick={() => onDeleteMessage(m.id)}
                  title="Remove from context"
                  style={{
                    background: 'rgba(255,60,60,0.12)', border: '1px solid rgba(255,60,60,0.3)',
                    borderRadius: 4, cursor: 'pointer', padding: '2px 5px',
                    display: 'flex', alignItems: 'center', gap: 3,
                    color: 'rgba(255,100,100,0.85)', fontSize: 10, opacity: 0.9,
                  }}
                ><Trash2 size={10} /> delete</button>
              )}
            </div>
          )}
        </div>
      ))}

      {thinking && streamingContent && (
        <>
          <NarratedMessage message={streamingContent} type="suny" isActive={true} timestamp={Date.now()} />
          <div style={{
            display: 'flex', gap: 8, marginLeft: 38, marginBottom: 12,
            alignItems: 'center', fontSize: 13, color: 'var(--text-secondary)',
            fontStyle: 'italic',
          }}>
            <span className="dot-pulse" style={{
              display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
              background: 'var(--accent)', flexShrink: 0,
            }} />
            <span style={{ opacity: 0.85 }}>{thinkingStatus || 'Working on your request...'}</span>
          </div>
        </>
      )}

      {thinking && !streamingContent && <ThinkingIndicator statusText={thinkingStatus} />}
      <div ref={msgEndRef} />
    </div>
  );
}
