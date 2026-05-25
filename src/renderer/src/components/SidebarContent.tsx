import { ChevronRight, ChevronDown, Plus, FolderOpen, Folder, Trash2, Edit3, User, Play, Check, X } from 'lucide-react';
import FileTreeNode from './FileTreeNode';
import ReportBadgeButton from './ReportBadgeButton';
import type { Project, ProjectSpend, Memory, FileNode, CheckpointEntry, BlueprintEntry } from '../types';

interface SidebarContentProps {
  sidebarOpen: boolean;
  closeSidebar: () => void;
  collapsedSections: Record<string, boolean>;
  setCollapsedSections: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  projects: Project[];
  activeProject: Project | null;
  setActiveProject: React.Dispatch<React.SetStateAction<Project | null>>;
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
  projectSpend: Record<number, ProjectSpend>;
  memories: Memory[];
  setMemories: React.Dispatch<React.SetStateAction<Memory[]>>;
  saveMemories: (projectId: number, memories: Memory[]) => void;
  confirmClearMemories: boolean;
  setConfirmClearMemories: React.Dispatch<React.SetStateAction<boolean>>;
  showFileBrowser: boolean;
  setShowFileBrowser: React.Dispatch<React.SetStateAction<boolean>>;
  fileBrowser: FileNode[];
  expandedDirs: Set<string>;
  setExpandedDirs: React.Dispatch<React.SetStateAction<Set<string>>>;
  loadFileBrowser: (projectId: number) => void;
  bridgeConnected: boolean;
  setShowBridgeTip: React.Dispatch<React.SetStateAction<boolean>>;
  setShowNewProject: React.Dispatch<React.SetStateAction<boolean>>;
  blueprintEntries: BlueprintEntry[];
  loadBlueprintEntries: (projectId: number) => void;
  projectRules: string | null;
  setShowRulesEditor: React.Dispatch<React.SetStateAction<boolean>>;
  setRulesEditorContent: React.Dispatch<React.SetStateAction<string>>;
  setShowPersonaEditor: React.Dispatch<React.SetStateAction<boolean>>;
  setPersonaEditorContent: React.Dispatch<React.SetStateAction<string>>;
  setRecallingMemory: React.Dispatch<React.SetStateAction<Memory | null>>;
  setEditingMemory: React.Dispatch<React.SetStateAction<Memory | null>>;
  editTitle: string;
  setEditTitle: React.Dispatch<React.SetStateAction<string>>;
  editSummary: string;
  setEditSummary: React.Dispatch<React.SetStateAction<string>>;
  deleteMemory: (id: string) => void;
  devServerUrl: string | null;
  devServerRunning: boolean;
  devServerLoading: boolean;
  startDevServer: () => void;
  stopDevServer: () => void;
  checkpoints: CheckpointEntry[];
  rollingBack: string | null;
  rollbackConfirm: string | null;
  setRollbackConfirm: React.Dispatch<React.SetStateAction<string | null>>;
  loadCheckpoints: (projectId: number) => void;
  rollbackToCheckpoint: (sha: string) => void;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  summarizeProjectMessages: (projectId: number) => any;
  deleteProject: (id: number) => void;
  openProject: (project: Project) => void;
  blueprintCategoryLabel: (cat: string) => string;
  blueprintCategoryColor: (cat: string) => string;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}

export default function SidebarContent(props: SidebarContentProps) {
  const {
    sidebarOpen, closeSidebar, collapsedSections, setCollapsedSections,
    projects, activeProject, setActiveProject, setMessages,
    projectSpend, memories, setMemories, saveMemories,
    confirmClearMemories, setConfirmClearMemories,
    showFileBrowser, setShowFileBrowser, fileBrowser, expandedDirs, setExpandedDirs,
    loadFileBrowser, bridgeConnected, setShowBridgeTip, setShowNewProject,
    blueprintEntries, loadBlueprintEntries,
    projectRules, setShowRulesEditor, setRulesEditorContent,
    setShowPersonaEditor, setPersonaEditorContent,
    setRecallingMemory, setEditingMemory, editTitle, setEditTitle, editSummary, setEditSummary, deleteMemory,
    devServerUrl, devServerRunning, devServerLoading, startDevServer, stopDevServer,
    checkpoints, rollingBack, rollbackConfirm, setRollbackConfirm, loadCheckpoints, rollbackToCheckpoint,
    setInput, summarizeProjectMessages, deleteProject, openProject,
    blueprintCategoryLabel, blueprintCategoryColor,
  } = props;

  return (
    <>
      {/* Sidebar overlay backdrop — only shown on mobile when sidebar is open */}
      {sidebarOpen && (
        <div className="sidebar-overlay" onClick={closeSidebar} style={{ display: 'none' }} />
      )}
      {/* Projects sidebar */}
      <div className={`sidebar${sidebarOpen ? ' sidebar-open' : ''}`} style={{
        width: 220, borderRight: '1px solid var(--border)', display: 'flex',
        flexDirection: 'column', padding: '12px 0', flexShrink: 0,
      }}>
        <div style={{ padding: '0 12px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span
            style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={() => setCollapsedSections(s => ({ ...s, projects: !s.projects }))}
          >
            {collapsedSections.projects ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
            Projects
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            {activeProject && (
              <button
                className="btn btn-icon btn-secondary btn-sm"
                onClick={() => {
                  if (!bridgeConnected) { setShowBridgeTip(true); return; }
                  setShowFileBrowser(v => { const next = !v; if (!v && activeProject) loadFileBrowser(activeProject.id); return next; });
                }}
                title={showFileBrowser ? 'Hide file browser' : (bridgeConnected ? 'Show file browser' : 'Bridge required — click to connect')}
              >
                {showFileBrowser ? <FolderOpen size={12} /> : <Folder size={12} />}
              </button>
            )}
            <button className="btn btn-icon btn-secondary btn-sm" onClick={() => setShowNewProject(true)} title="New project">
              <Plus size={13} />
            </button>
          </div>
        </div>

        {!collapsedSections.projects && (
          <>
            {projects.map(p => {
              const projectReport = summarizeProjectMessages(p.id);
              return (
                <div
                  key={p.id}
                  onClick={() => openProject(p)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 12px', cursor: 'pointer',
                    background: activeProject?.id === p.id ? 'rgba(108,99,255,0.1)' : 'transparent',
                    borderLeft: activeProject?.id === p.id ? '2px solid var(--accent)' : '2px solid transparent',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{
                        fontSize: 13, color: activeProject?.id === p.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {p.name}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                        {(() => {
                          const spend = projectSpend[p.id];
                          return spend ? `Spent ${formatTokenCount(spend.total_tokens)} tok / ${formatSpend(spend.total_cost)}` : 'Spent 0 tok / $0.00';
                        })()}
                      </div>
                    </div>
                    <ReportBadgeButton report={projectReport} label="Project report" />
                  </div>
                  <button
                    className="btn btn-icon btn-sm"
                    onClick={e => { e.stopPropagation(); deleteProject(p.id); }}
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', padding: 2 }}
                    title="Remove project"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              );
            })}

            {projects.length === 0 && (
              <p style={{ padding: '0 12px', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                No projects yet. Click + to add one.
              </p>
            )}
          </>
        )}

        {/* Memories section */}
        {activeProject && (
          <>
            <div style={{ padding: '16px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border)', marginTop: 4 }}>
              <span
                style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                onClick={() => setCollapsedSections(s => ({ ...s, memories: !s.memories }))}
              >
                {collapsedSections.memories ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                Memories
              </span>
              {memories.length > 0 && !collapsedSections.memories && (
                confirmClearMemories ? (
                  <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Clear all?</span>
                    <button
                      className="btn btn-icon btn-sm"
                      onClick={() => { if (activeProject) { setMemories([]); saveMemories(activeProject.id, []); } setConfirmClearMemories(false); }}
                      title="Confirm clear"
                      style={{ background: 'none', border: 'none', color: 'var(--error)', padding: 2, cursor: 'pointer', fontWeight: 700, fontSize: 12 }}
                    ><Check size={12} /></button>
                    <button
                      className="btn btn-icon btn-sm"
                      onClick={() => setConfirmClearMemories(false)}
                      title="Cancel"
                      style={{ background: 'none', border: 'none', color: 'var(--text-muted)', padding: 2, cursor: 'pointer', fontSize: 12 }}
                    ><X size={12} /></button>
                  </div>
                ) : (
                  <button
                    className="btn btn-icon btn-sm"
                    onClick={() => setConfirmClearMemories(true)}
                    title="Clear all memories"
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', padding: 2, cursor: 'pointer', fontSize: 10 }}
                  >
                    <Trash2 size={11} />
                  </button>
                )
              )}
            </div>

            {!collapsedSections.memories && (
              <>
                {memories.length === 0 && (
                  <p style={{ padding: '0 12px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, marginTop: 4 }}>
                    Clear a chat to save it here.
                  </p>
                )}
                <div style={{ overflow: 'auto', maxHeight: 240 }}>
                  {memories.map(m => (
                    <div
                      key={m.id}
                      style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)', transition: 'background 0.15s' }}
                      onClick={() => setRecallingMemory(m)}
                      title="Click to recall this memory"
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {m.title}
                        </span>
                        <div style={{ display: 'flex', gap: 2, flexShrink: 0, marginLeft: 4 }}>
                          <button
                            className="btn btn-icon btn-sm"
                            onClick={e => { e.stopPropagation(); setEditingMemory(m); setEditTitle(m.title); setEditSummary(m.summary); }}
                            title="Edit memory"
                            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', padding: 2, cursor: 'pointer' }}
                          >
                            <Edit3 size={10} />
                          </button>
                          <button
                            className="btn btn-icon btn-sm"
                            onClick={e => { e.stopPropagation(); deleteMemory(m.id); }}
                            title="Delete memory"
                            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', padding: 2, cursor: 'pointer' }}
                          >
                            <Trash2 size={10} />
                          </button>
                        </div>
                      </div>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {m.summary}
                      </p>
                      <p style={{ fontSize: 10, color: 'var(--text-muted)', opacity: 0.6, margin: '2px 0 0' }}>
                        {new Date(m.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {/* Rules section */}
        {activeProject && (
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
            <div style={{ padding: '12px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span
                style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                onClick={() => setCollapsedSections(s => ({ ...s, rules: !s.rules }))}
              >
                {collapsedSections.rules ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                Rules
              </span>
              <button
                className="btn btn-icon btn-sm"
                onClick={() => { setRulesEditorContent(projectRules ?? ''); setShowRulesEditor(true); }}
                title="Edit project rules"
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', padding: 2, cursor: 'pointer' }}
              >
                <Edit3 size={11} />
              </button>
            </div>
            {!collapsedSections.rules && (projectRules ? (
              <div style={{ padding: '0 12px 8px', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 100, overflowY: 'auto', opacity: 0.8 }}>
                {projectRules.slice(0, 300)}{projectRules.length > 300 ? '…' : ''}
              </div>
            ) : (
              <p style={{ padding: '0 12px 8px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                No rules set. Click ✏️ to add coding guidelines for this project.
              </p>
            ))}
          </div>
        )}

        {/* Persona section */}
        {activeProject && (
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
            <div style={{ padding: '12px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span
                style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                onClick={() => setCollapsedSections(s => ({ ...s, persona: !s.persona }))}
              >
                {collapsedSections.persona ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                Persona
              </span>
              <button
                className="btn btn-icon btn-sm"
                onClick={() => { setPersonaEditorContent(activeProject.persona ?? ''); setShowPersonaEditor(true); }}
                title="Edit AI persona for this project"
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', padding: 2, cursor: 'pointer' }}
              >
                <User size={11} />
              </button>
            </div>
            {!collapsedSections.persona && (activeProject.persona ? (
              <div style={{ padding: '0 12px 8px', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 70, overflowY: 'auto', opacity: 0.8 }}>
                {activeProject.persona.slice(0, 200)}{(activeProject.persona?.length ?? 0) > 200 ? '…' : ''}
              </div>
            ) : (
              <p style={{ padding: '0 12px 8px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                No persona. Click 👤 to give SUNy a role for this project.
              </p>
            ))}
          </div>
        )}

        {/* Blueprint section */}
        {activeProject && blueprintEntries.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
            <div style={{ padding: '12px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span
                style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                onClick={() => setCollapsedSections(s => ({ ...s, blueprint: s['blueprint'] !== false ? false : true }))}
              >
                {collapsedSections['blueprint'] !== false ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                Blueprint
              </span>
              <button
                className="btn btn-icon btn-sm"
                onClick={() => loadBlueprintEntries(activeProject.id)}
                title="Refresh blueprint"
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', padding: 2, cursor: 'pointer', fontSize: 10 }}
              >↻</button>
            </div>
            {collapsedSections['blueprint'] === false && (
              <div style={{ overflowY: 'auto', maxHeight: 220 }}>
                {blueprintEntries.slice(0, 20).map(e => (
                  <div key={e.id} style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                      <span style={{
                        fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
                        color: blueprintCategoryColor(e.category),
                        border: `1px solid ${blueprintCategoryColor(e.category)}`,
                        borderRadius: 3, padding: '1px 4px', flexShrink: 0,
                      }}>
                        {blueprintCategoryLabel(e.category)}
                      </span>
                      <span style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0 }}>
                        {new Date(e.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.summary}>
                      {e.summary}
                    </div>
                    {e.intent && (
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }} title={e.intent}>
                        ↳ {e.intent}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* File Browser section */}
        {activeProject && showFileBrowser && (
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
            <div style={{ padding: '12px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Files</span>
              <button
                className="btn btn-icon btn-sm"
                onClick={() => loadFileBrowser(activeProject.id)}
                title="Refresh file list"
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', padding: 2, cursor: 'pointer' }}
              >↻</button>
            </div>
            <div style={{ maxHeight: 200, overflowY: 'auto', fontSize: 11 }}>
              {fileBrowser.length === 0 && <p style={{ padding: '0 12px 8px', color: 'var(--text-muted)' }}>No files loaded.</p>}
              {fileBrowser.map(node => (
                <FileTreeNode
                  key={node.path}
                  node={node}
                  expandedDirs={expandedDirs}
                  onToggle={p => setExpandedDirs(prev => {
                    const next = new Set(prev);
                    next.has(p) ? next.delete(p) : next.add(p);
                    return next;
                  })}
                  onFileClick={node => setInput(prev => prev + `\n@file:${node.path}`)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Live Dev Server section */}
        {activeProject && bridgeConnected && (
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
            <div style={{ padding: '12px 12px 8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Dev Server
                </span>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {devServerRunning && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', display: 'inline-block' }} />}
                </div>
              </div>
              {devServerRunning && devServerUrl ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <a href={devServerUrl} target="_blank" rel="noreferrer"
                    style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {devServerUrl}
                  </a>
                  <button className="btn btn-secondary btn-sm" style={{ fontSize: 11, padding: '3px 8px', color: 'var(--error)', borderColor: 'var(--error)' }}
                    onClick={stopDevServer} disabled={devServerLoading}>
                    {devServerLoading ? '…' : 'Stop'}
                  </button>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                    Dev server ON means your app is running live for preview/testing. Turning it OFF only stops preview, not SUNy file access.
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <button className="btn btn-secondary btn-sm"
                    style={{ fontSize: 11, padding: '4px 10px', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                    onClick={() => { if (!bridgeConnected) { setShowBridgeTip(true); return; } startDevServer(); }}
                    disabled={devServerLoading}>
                    <Play size={11} />
                    {devServerLoading ? 'Starting...' : 'Start Dev Server'}
                  </button>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                    Dev server shows your app live in browser. Bridge controls file/terminal actions; dev server controls preview only.
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Checkpoints section */}
        {activeProject && checkpoints.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
            <div style={{ padding: '12px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Checkpoints</span>
              <button className="btn btn-icon btn-sm" onClick={() => loadCheckpoints(activeProject.id)}
                title="Refresh checkpoints"
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', padding: 2, cursor: 'pointer', fontSize: 10 }}
              >↻</button>
            </div>
            <div style={{ overflowY: 'auto', maxHeight: 180 }}>
              {checkpoints.map(cp => (
                <div key={cp.sha} style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 2 }}>
                    {cp.message.replace('SUNy checkpoint: ', '')}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
                        {cp.sha.slice(0, 7)}
                      </span>
                      {cp.date && (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          {new Date(cp.date).toLocaleDateString()} {new Date(cp.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                      {cp.filesChanged !== undefined && cp.filesChanged > 0 && (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          {cp.filesChanged} file{cp.filesChanged !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    {rollbackConfirm === cp.sha ? (
                      <div style={{ display: 'flex', gap: 3, alignItems: 'center', flexShrink: 0 }}>
                        <span style={{ fontSize: 10, color: 'var(--error)' }}>Overwrite?</span>
                        <button className="btn btn-sm" onClick={() => rollbackToCheckpoint(cp.sha)}
                          disabled={rollingBack === cp.sha}
                          style={{ fontSize: 10, padding: '2px 5px', background: 'var(--error)', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer' }}>
                          {rollingBack === cp.sha ? '…' : 'Yes'}
                        </button>
                        <button className="btn btn-sm" onClick={() => setRollbackConfirm(null)}
                          style={{ fontSize: 10, padding: '2px 5px', background: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 3, cursor: 'pointer' }}>
                          No
                        </button>
                      </div>
                    ) : (
                      <button className="btn btn-sm btn-secondary" onClick={() => setRollbackConfirm(cp.sha)}
                        disabled={!!rollingBack} title="Roll back to this checkpoint"
                        style={{ fontSize: 10, padding: '2px 6px', flexShrink: 0 }}>
                        Restore
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function formatSpend(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(6)}`;
}
