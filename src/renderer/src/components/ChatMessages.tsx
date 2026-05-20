import { Eraser, X, FolderOpen, ChevronRight, ChevronDown, Copy, Trash2 } from 'lucide-react';
import NarratedMessage, { ThinkingIndicator } from './NarratedMessage';
import type { Message, ProofRun, Project } from '../types';

interface ChatMessagesProps {
  messages: Message[];
  activeProject: Project | null;
  thinking: boolean;
  streamingContent: string;
  thinkingStatus: string;
  proofRuns: ProofRun[];
  globalTabs: { id: string; name: string }[];
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
  setRenamingTabId: React.Dispatch<React.SetStateAction<string | null>>;
  setRenamingTabValue: React.Dispatch<React.SetStateAction<string>>;
  setDeleteConfirmTabId: React.Dispatch<React.SetStateAction<string | null>>;
  switchGlobalTab: (tabId: string) => void;
  closeGlobalTab: (tabId: string) => void;
  addGlobalTab: () => void;
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
    deleteConfirmTabId, projectStateReady, globalIntroLine, projects,
    bridgeConnected, expandedRunIds, msgEndRef,
    clearChat, setRenamingTabId, setRenamingTabValue, setDeleteConfirmTabId,
    switchGlobalTab, closeGlobalTab, addGlobalTab, setShowBridgeTip, openProject,
    copyProofReportToClipboard, setExpandedRunIds, toolLabel,
  } = props;

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

      {/* Global chat: tab bar */}
      {!activeProject && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4, marginBottom: 16, flexWrap: 'wrap',
          position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg)', paddingTop: 4, paddingBottom: 4,
        }}>
          {globalTabs.map(tab => (
            <div
              key={tab.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '4px 10px 4px 12px',
                borderRadius: 20,
                border: `1px solid ${activeTabId === tab.id ? 'var(--accent)' : 'var(--border)'}`,
                background: activeTabId === tab.id ? 'rgba(41,255,122,0.08)' : 'var(--surface)',
                cursor: 'pointer',
                fontSize: 12,
                color: activeTabId === tab.id ? 'var(--accent)' : 'var(--text-secondary)',
                transition: 'all 0.15s',
                position: 'relative',
              }}
              onClick={() => switchGlobalTab(tab.id)}
              onDoubleClick={() => { setRenamingTabId(tab.id); setRenamingTabValue(tab.name); }}
            >
              {renamingTabId === tab.id ? (
                <input
                  value={renamingTabValue}
                  onChange={e => setRenamingTabValue(e.target.value)}
                  onBlur={() => {
                    if (renamingTabValue.trim()) {
                      const updated = globalTabs.map(t => t.id === tab.id ? { ...t, name: renamingTabValue.trim() } : t);
                      setRenamingTabId(null);
                    }
                    setRenamingTabId(null);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') { setRenamingTabId(null); }
                  }}
                  autoFocus
                  style={{ width: 80, fontSize: 12, padding: '0 2px', background: 'transparent', border: 'none', outline: 'none', color: 'inherit' }}
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <span>{tab.name}</span>
              )}
              {deleteConfirmTabId === tab.id ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 10, color: 'var(--error)', whiteSpace: 'nowrap' }}>Delete?</span>
                  <button
                    onClick={e => { e.stopPropagation(); closeGlobalTab(tab.id); setDeleteConfirmTabId(null); }}
                    style={{ background: 'var(--error)', border: 'none', cursor: 'pointer', color: '#fff', padding: '1px 5px', borderRadius: 3, fontSize: 10, lineHeight: 1 }}
                    title="Confirm delete"
                  >✓</button>
                  <button
                    onClick={e => { e.stopPropagation(); setDeleteConfirmTabId(null); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '1px 4px', fontSize: 10, lineHeight: 1 }}
                    title="Cancel"
                  >✕</button>
                </div>
              ) : (
                <button
                  onClick={e => { e.stopPropagation(); setDeleteConfirmTabId(tab.id); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex', alignItems: 'center', fontSize: 10, lineHeight: 1 }}
                  title="Delete tab"
                >
                  <Trash2 size={10} />
                </button>
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

      {/* Empty state: global */}
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
                  onClick={() => {
                    openProject(p);
                  }}
                >
                  <FolderOpen size={12} />
                  {p.name}
                </button>
              ))}
            </div>
          )}
          {!bridgeConnected && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', opacity: 0.7 }}>
              <button
                onClick={() => setShowBridgeTip(true)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: 12, padding: 0, textDecoration: 'underline' }}
              >
                🔌 Connect the Bridge
              </button>{' '}to unlock file editing & shell commands.
            </p>
          )}
        </div>
      )}

      {/* Empty state: project */}
      {activeProject && messages.length === 0 && !thinking && (
        <div style={{ textAlign: 'center', marginTop: 40, color: 'var(--text-muted)' }}>
          <img src="/SLOGO.png" alt="SUNy" style={{ width: 'clamp(100px, 14vw, 180px)', height: 'clamp(100px, 14vw, 180px)', borderRadius: '50%', objectFit: 'cover', marginBottom: 14, boxShadow: '0 4px 20px rgba(108,99,255,0.2)' }} />
          <p style={{ fontWeight: 700, fontSize: 22, marginBottom: 6, color: 'var(--text-primary)' }}>Hi! I'm SUNy</p>
          <p style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--accent)', marginBottom: 10, opacity: 0.9 }}>Consider it done.</p>
          <p style={{ fontSize: 14 }}>Tell me what you'd like to build or fix. I'll take it from there!</p>
          {!bridgeConnected && (
            <p style={{ fontSize: 12, marginTop: 12, color: 'var(--text-muted)', opacity: 0.7 }}>
              <button
                onClick={() => setShowBridgeTip(true)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: 12, padding: 0, textDecoration: 'underline' }}
              >
                🔌 Connect the Bridge
              </button>{' '}to unlock file editing & shell commands.
            </p>
          )}
        </div>
      )}

      {/* Proof Panel */}
      {proofRuns.length > 0 && (
        <div style={{
          marginBottom: 12,
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--surface)',
          padding: '0',
          overflow: 'hidden',
        }}>
          {/* Proof Panel Header */}
          <div style={{
            padding: '10px 12px',
            borderBottom: proofRuns.length > 1 ? '1px solid var(--border)' : 'none',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
          }}>
            <strong style={{ fontSize: 12, color: 'var(--text-primary)' }}>
              Proof Panel {proofRuns.length > 1 ? `(${proofRuns.length})` : ''}
            </strong>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {proofRuns[0].status === 'running' ? '🔄 In progress' : proofRuns[0].status === 'completed' ? '✅ Completed' : '⚠️ Needs attention'}
            </div>
          </div>

          {/* Active Run (always shown) */}
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
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--accent)',
                    fontSize: 11,
                    padding: '2px 6px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
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
                ? proofRuns[0].toolCalls.map(toolLabel).join(' → ')
                : 'None yet'}
            </div>
            {proofRuns[0].checks.length > 0 && (
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
                <strong style={{ color: 'var(--text-primary)' }}>Last checks:</strong> {proofRuns[0].checks.slice(-2).join(' | ')}
              </div>
            )}
          </div>

          {/* Run History (collapsible) */}
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
                  {proofRuns.slice(1).map((run, idx) => {
                    const isExpanded = expandedRunIds.has(run.id);
                    const duration = run.durationMs ?? ((run.finishedAt ?? Date.now()) - run.startedAt);
                    const durationSec = (duration / 1000).toFixed(1);
                    return (
                      <div key={run.id} style={{ borderTop: '1px solid var(--border)', padding: 0 }}>
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
                          <span style={{
                            color: run.status === 'completed' ? 'var(--success)' : run.status === 'failed' ? 'var(--error)' : 'var(--warning)',
                            fontWeight: 600,
                          }}>
                            {run.status === 'completed' ? '✓' : run.status === 'failed' ? '✗' : '○'}
                          </span>
                          <span>{new Date(run.startedAt).toLocaleTimeString()}</span>
                          <span>· {durationSec}s</span>
                          <span>· {run.toolCalls.length} tools</span>
                        </div>

                        {isExpanded && (
                          <div style={{
                            padding: '6px 12px 8px 24px',
                            fontSize: 10,
                            background: 'rgba(0,0,0,0.15)',
                            borderTop: '1px solid var(--border)',
                          }}>
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
                            {run.status === 'completed' && (
                              <button
                                onClick={() => copyProofReportToClipboard(run)}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  cursor: 'pointer',
                                  color: 'var(--accent)',
                                  fontSize: 10,
                                  padding: 0,
                                  marginTop: 4,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 3,
                                }}
                                title="Copy proof report"
                              >
                                <Copy size={9} /> Copy report
                              </button>
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
        </div>
      )}

      {/* Messages */}
      {messages.map(m => (
        <NarratedMessage key={m.id} message={m.content} type={m.type} timestamp={m.timestamp} report={m.report} />
      ))}
      {thinking && streamingContent && (
        <>
          <NarratedMessage message={streamingContent} type="suny" isActive={true} timestamp={Date.now()} />
          {(thinkingStatus || true) && (
            <div style={{
              display: 'flex', gap: 8, marginLeft: 38, marginBottom: 12,
              alignItems: 'center', fontSize: 13, color: 'var(--text-secondary)',
              fontStyle: 'italic',
            }}>
              <span className="dot-pulse" style={{
                display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                background: 'var(--accent)', flexShrink: 0,
              }} />
              <span style={{ opacity: 0.85 }}>{thinkingStatus || 'Working on your request…'}</span>
            </div>
          )}
        </>
      )}
      {thinking && !streamingContent && <ThinkingIndicator statusText={thinkingStatus} />}
      <div ref={msgEndRef} />
    </div>
  );
}
