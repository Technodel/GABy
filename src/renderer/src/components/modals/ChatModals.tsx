import { useState } from 'react';
import {
  HelpCircle, X, BarChart2, User, FileText, Trash2, RotateCcw,
  FolderOpen, Sparkles, ChevronRight, ChevronDown, Play, Copy,
} from 'lucide-react';

// ── Shared types ────────────────────────────────────────────────────────────

export interface Project {
  id: number; name: string; local_path: string; persona?: string | null;
}

export interface Mode { mode: string; display_name: string; session_limit_label: string; }

export interface Memory {
  id: string; projectId: number; title: string; summary: string;
  createdAt: number; updatedAt: number;
}

export interface UsageDay { day: string; input_tokens: number; output_tokens: number; charged_cost: number; }
export interface UsageMode { mode: string; input_tokens: number; output_tokens: number; charged_cost: number; }
export interface UsageTotals { input_tokens: number; output_tokens: number; charged_cost: number; cache_read_tokens?: number; }

// ── Folder Select Modal ─────────────────────────────────────────────────────

interface FolderModalProps {
  selectedFolder: FileSystemDirectoryHandle | null;
  onClose: () => void;
  onSelectFolder: () => void;
}

export function FolderModal({ selectedFolder, onClose, onSelectFolder }: FolderModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
        {selectedFolder ? (
          <>
            <div style={{ textAlign: 'center', padding: '12px 0 8px' }}>
              <div style={{ fontSize: 32, marginBottom: 6 }}>�</div>
              <h3 style={{ margin: '0 0 6px', fontSize: 17 }}>Folder selected!</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                SUNy can now read &amp; write files in your selected folder.
              </p>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-primary" onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <>
            <h3 style={{ margin: '0 0 4px', fontSize: 17 }}>� Select a Folder</h3>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, margin: '0 0 6px' }}>
              Use the browser file picker to select your project folder.
              SUNy needs it to <strong>create files, edit code, and run commands</strong>.
            </p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <div style={{ flex: 1, background: 'var(--bg-secondary)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Without Folder</div>
                {['💬 Chat & answer questions', '🧠 Code review & analysis', '📋 Architecture advice'].map(t => (
                  <div key={t} style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 3 }}>{t}</div>
                ))}
              </div>
              <div style={{ flex: 1, background: 'rgba(108,99,255,0.07)', border: '1px solid rgba(108,99,255,0.2)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.4px' }}>With Folder ✨</div>
                {['✏️ Create & edit files', '⚡ Run shell commands', '🔧 Auto-fix lint errors', '📦 Git auto-commit'].map(t => (
                  <div key={t} style={{ fontSize: 12, color: 'var(--text-primary)', marginBottom: 3 }}>{t}</div>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
              <button className="btn btn-primary" onClick={onSelectFolder}>
                📁 Select Project Folder
              </button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-secondary" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Recall Memory Modal ──────────────────────────────────────────────────────

interface RecallMemoryModalProps {
  memory: Memory;
  onRecall: (mem: Memory) => void;
  onClose: () => void;
}

export function RecallMemoryModal({ memory, onRecall, onClose }: RecallMemoryModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3 className="modal-title">Recall Memory</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>Insert this memory into a fresh chat?</p>
        <div style={{ background: 'var(--bg)', padding: 12, borderRadius: 'var(--radius)', marginBottom: 16 }}>
          <p style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{memory.title}</p>
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{memory.summary}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onRecall(memory)}>
            <RotateCcw size={14} style={{ marginRight: 6 }} />Recall
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit Memory Modal ────────────────────────────────────────────────────────

interface EditMemoryModalProps {
  memory: Memory;
  onSave: (id: string, title: string, summary: string) => void;
  onClose: () => void;
}

export function EditMemoryModal({ memory, onSave, onClose }: EditMemoryModalProps) {
  const [title, setTitle] = useState(memory.title);
  const [summary, setSummary] = useState(memory.summary);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3 className="modal-title">Edit Memory</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Title</label>
            <input value={title} onChange={e => setTitle(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Summary</label>
            <textarea value={summary} onChange={e => setSummary(e.target.value)} rows={3} style={{ width: '100%', resize: 'vertical' }} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => { if (title.trim()) onSave(memory.id, title.trim(), summary.trim()); }} disabled={!title.trim()}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Project Rules Editor Modal ───────────────────────────────────────────────

interface RulesEditorModalProps {
  projectName: string;
  content: string;
  hasExistingRules: boolean;
  onSave: (content: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function RulesEditorModal({ projectName, content, hasExistingRules, onSave, onDelete, onClose }: RulesEditorModalProps) {
  const [editorContent, setEditorContent] = useState(content);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <h3 className="modal-title">
          <FileText size={16} style={{ marginRight: 8, verticalAlign: 'text-bottom' }} />
          Project Rules — {projectName}
        </h3>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
          These rules are saved to <code style={{ background: 'var(--bg)', padding: '1px 4px', borderRadius: 3 }}>.suny-rules</code> in your project folder and injected into every conversation for this project.
          <br />Write coding preferences, forbidden patterns, naming conventions, or anything SUNy should always follow.
        </p>
        <textarea
          value={editorContent}
          onChange={e => setEditorContent(e.target.value)}
          placeholder={"# Project Rules\n\n- Use TypeScript strict mode\n- Prefer functional components\n- All API routes must be RESTful\n- Never use console.log in production code"}
          rows={12}
          autoFocus
          style={{ width: '100%', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          {hasExistingRules && (
            <button className="btn btn-secondary" style={{ color: 'var(--error)', borderColor: 'var(--error)' }} onClick={onDelete}>
              <Trash2 size={13} style={{ marginRight: 6 }} />Delete Rules
            </button>
          )}
          <button className="btn btn-primary" onClick={() => onSave(editorContent)}>Save Rules</button>
        </div>
      </div>
    </div>
  );
}

// ── New Project Modal ────────────────────────────────────────────────────────

interface NewProjectModalProps {
  onCreate: (name: string, path: string) => Promise<void>;
  onScratchBuild: (name: string, path: string, description: string) => Promise<void>;
  onPickFolder: (cb: (path: string) => void) => void;
  onClose: () => void;
}

export function NewProjectModal({ onCreate, onScratchBuild, onPickFolder, onClose }: NewProjectModalProps) {
  const [mode, setMode] = useState<'link' | 'scratch'>('link');
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [pathError, setPathError] = useState('');
  const [description, setDescription] = useState('');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3 className="modal-title">New Project</h3>
        <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
          <button onClick={() => setMode('link')} style={{
            flex: 1, padding: '7px 0', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
            background: mode === 'link' ? 'var(--accent)' : 'transparent',
            color: mode === 'link' ? '#fff' : 'var(--text-muted)',
          }}>📁 Link Existing</button>
          <button onClick={() => setMode('scratch')} style={{
            flex: 1, padding: '7px 0', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
            background: mode === 'scratch' ? 'var(--accent)' : 'transparent',
            color: mode === 'scratch' ? '#fff' : 'var(--text-muted)',
          }}>✨ Build with SUNy</button>
        </div>

        {mode === 'link' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Project Name</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="My Awesome App" autoFocus />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>📁 Project Folder</label>
              <button type="button" onClick={() => onPickFolder((picked) => {
                setPath(picked);
                const parts = picked.replace(/\\/g, '/').split('/').filter(Boolean);
                if (!name) setName(parts[parts.length - 1] || '');
              })} style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                padding: '14px 0', borderRadius: 8, border: '2px dashed var(--border)',
                cursor: 'pointer', marginBottom: 8, color: 'var(--text-muted)',
                background: 'var(--bg-secondary)',
              }}>
                <FolderOpen size={22} style={{ color: 'var(--accent)' }} />
                <span style={{ fontSize: 13 }}>{path || 'Click to choose a folder'}</span>
              </button>
              <input value={path} onChange={e => { setPath(e.target.value); setPathError(''); }}
                placeholder="Or type path manually, e.g. C:\Users\me\projects\my-app"
                style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, width: '100%', borderColor: pathError ? 'var(--color-error, #e74c3c)' : undefined }} />
              {pathError && <div style={{ fontSize: 12, color: 'var(--color-error, #e74c3c)', marginTop: 4 }}>{pathError}</div>}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Project Name</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="My Awesome App" autoFocus />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>📁 Where to create it</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={path} onChange={e => { setPath(e.target.value); setPathError(''); }}
                  placeholder="e.g. C:\Users\me\projects"
                  style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, flex: 1 }} />
                <button className="btn btn-secondary" type="button" style={{ whiteSpace: 'nowrap' }} onClick={() => onPickFolder(setPath)}>📁</button>
              </div>
              {pathError && <div style={{ fontSize: 12, color: 'var(--color-error, #e74c3c)', marginTop: 4 }}>{pathError}</div>}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>SUNy will create a <code>{name || 'project'}</code> subfolder here.</div>
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                <Sparkles size={12} style={{ marginRight: 4 }} />Describe what you want to build
              </label>
              <textarea value={description} onChange={e => setDescription(e.target.value)}
                placeholder="e.g. A to-do app with React and a dark theme, with the ability to add, delete, and mark tasks as done."
                rows={4} style={{ width: '100%', fontFamily: 'inherit', fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }} />
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={() => { onClose(); setMode('link'); setDescription(''); }}>Cancel</button>
          {mode === 'link' ? (
            <button className="btn btn-primary" onClick={async () => { await onCreate(name, path); }}>Create with SUNy</button>
          ) : (
            <button className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              onClick={() => onScratchBuild(name, path, description)}>
              <Sparkles size={13} /> Build with SUNy
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Persona Editor Modal ─────────────────────────────────────────────────────

interface PersonaEditorModalProps {
  projectName: string;
  currentPersona: string;
  onSave: (content: string) => void;
  onClose: () => void;
}

export function PersonaEditorModal({ projectName, currentPersona, onSave, onClose }: PersonaEditorModalProps) {
  const [editorContent, setEditorContent] = useState(currentPersona);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <h3 className="modal-title">
          <User size={16} style={{ marginRight: 8, verticalAlign: 'text-bottom' }} />
          AI Persona — {projectName}
        </h3>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
          Give SUNy a specific role or personality for this project. This is injected into every conversation.
          <br />Examples: <em>"Act as a senior Rails engineer. Never suggest Python."</em> or <em>"You are a security-focused code reviewer."</em>
        </p>
        <textarea value={editorContent} onChange={e => setEditorContent(e.target.value)}
          placeholder="Act as a senior TypeScript engineer focused on clean architecture. Prefer functional patterns. Never use any."
          rows={6} autoFocus style={{ width: '100%', resize: 'vertical', boxSizing: 'border-box', fontSize: 13 }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          {currentPersona && (
            <button className="btn btn-secondary" style={{ color: 'var(--error)', borderColor: 'var(--error)' }}
              onClick={() => onSave('')}><Trash2 size={13} style={{ marginRight: 6 }} />Clear</button>
          )}
          <button className="btn btn-primary" onClick={() => onSave(editorContent)}>Save Persona</button>
        </div>
      </div>
    </div>
  );
}

// ── Usage Dashboard Modal ────────────────────────────────────────────────────

interface UsageDashboardModalProps {
  usageByDay: UsageDay[];
  usageByMode: UsageMode[];
  usageTotals: UsageTotals | null;
  usageDays: number;
  balance: number;
  walletBalance: number;
  sessLimit: number | null;
  sessUsed: number;
  onChangeDays: (days: number) => void;
  onClose: () => void;
}

export function UsageDashboardModal({
  usageByDay, usageByMode, usageTotals, usageDays,
  balance, walletBalance, sessLimit, sessUsed,
  onChangeDays, onClose,
}: UsageDashboardModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 620, maxHeight: '80vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 className="modal-title" style={{ margin: 0 }}>
            <BarChart2 size={16} style={{ marginRight: 8, verticalAlign: 'text-bottom' }} />Usage Stats
          </h3>
          <div style={{ display: 'flex', gap: 6 }}>
            {[7, 14, 30, 90].map(d => (
              <button key={d} className={`btn btn-sm ${usageDays === d ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => onChangeDays(d)}>{d}d</button>
            ))}
          </div>
        </div>

        {usageTotals && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10, marginBottom: 20 }}>
            {[
              { label: 'Total Tokens', value: ((usageTotals.input_tokens + usageTotals.output_tokens) / 1000).toFixed(1) + 'K' },
              { label: 'Cache Hits', value: ((usageTotals.cache_read_tokens ?? 0) / 1000).toFixed(1) + 'K' },
              { label: 'Total Spent', value: '$' + usageTotals.charged_cost.toFixed(4) },
              { label: 'Remaining Credits', value: (balance + walletBalance).toFixed(4) },
              { label: 'Remaining Session Tokens', value: sessLimit == null ? 'Unlimited' : Math.max(0, sessLimit - sessUsed).toLocaleString() },
            ].map(({ label, value }) => (
              <div key={label} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '12px 14px', textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent)' }}>{value}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{label}</div>
              </div>
            ))}
          </div>
        )}

        {usageByDay.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Daily Tokens</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 80, overflow: 'hidden' }}>
              {(() => {
                const max = Math.max(...usageByDay.map(d => d.input_tokens + d.output_tokens), 1);
                return usageByDay.map(d => {
                  const total = d.input_tokens + d.output_tokens;
                  const h = Math.max(2, Math.round((total / max) * 76));
                  return (
                    <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}
                      title={`${d.day}: ${total.toLocaleString()} tokens`}>
                      <div style={{ width: '100%', height: h, background: 'var(--accent)', borderRadius: '2px 2px 0 0', opacity: 0.8 }} />
                    </div>
                  );
                });
              })()}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
              <span>{usageByDay[0]?.day?.slice(5)}</span>
              <span>{usageByDay[usageByDay.length - 1]?.day?.slice(5)}</span>
            </div>
          </div>
        )}

        {usageByMode.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>By Mode</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {usageByMode.map(m => {
                const total = m.input_tokens + m.output_tokens;
                const maxTotal = Math.max(...usageByMode.map(x => x.input_tokens + x.output_tokens), 1);
                const pct = Math.round((total / maxTotal) * 100);
                return (
                  <div key={m.mode}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                      <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{m.mode}</span>
                      <span style={{ color: 'var(--text-muted)' }}>{(total / 1000).toFixed(1)}K · ${m.charged_cost.toFixed(4)}</span>
                    </div>
                    <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.4s' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {usageByDay.length === 0 && usageByMode.length === 0 && (
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '24px 0' }}>
            No usage data yet. Start chatting to see stats here!
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ── Onboarding Modal ─────────────────────────────────────────────────────────

interface OnboardingModalProps {
  onDismiss: () => void;
}

export function OnboardingModal({ onDismiss }: OnboardingModalProps) {
  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div style={{ textAlign: 'center', padding: '8px 0 16px' }}>
          <img src="/SLOGO.png" alt="SUNy" style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover', marginBottom: 10, boxShadow: '0 4px 16px rgba(108,99,255,0.3)' }} />
          <h2 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 700 }}>Welcome to SUNy!</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6, margin: '0 0 20px' }}>
            Your personal AI assistant — ask anything, build anything. Here's how to start:
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
          {[
            { icon: '📁', title: 'Create or open a project', desc: 'Click "+ New" in the sidebar to link a folder on your computer or let SUNy create one from scratch.' },
            { icon: '💬', title: 'Just talk to SUNy', desc: 'Ask questions, get explanations, request changes. SUNy understands what you want and gets it done.' },
            { icon: '⚡', title: 'Connect the Bridge for full power', desc: 'The Bridge lets SUNy actually write files and run commands on your machine — one terminal command to set up.' },
          ].map((step, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '10px 14px', background: 'var(--bg-secondary)', borderRadius: 8 }}>
              <span style={{ fontSize: 20, flexShrink: 0 }}>{step.icon}</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{step.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{step.desc}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" style={{ padding: '9px 24px' }} onClick={onDismiss}>Get Started →</button>
        </div>
      </div>
    </div>
  );
}

// ── Help / Shortcuts Modal ───────────────────────────────────────────────────

interface HelpModalProps {
  onClose: () => void;
}

export function HelpModal({ onClose }: HelpModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 540, maxHeight: '80vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 className="modal-title" style={{ margin: 0 }}>
            <HelpCircle size={16} style={{ marginRight: 8, verticalAlign: 'text-bottom' }} />Help & Shortcuts
          </h3>
          <button className="btn btn-icon btn-secondary" onClick={onClose}><X size={14} /></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <section>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', marginBottom: 8 }}>Keyboard Shortcuts</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <tbody>
                {[
                  ['Enter', 'Send message'],
                  ['Shift + Enter', 'New line in input'],
                  ['Esc', 'Stop current AI response'],
                  ['Ctrl + L', 'Clear current chat'],
                ].map(([key, desc]) => (
                  <tr key={key} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '7px 0', width: '40%' }}>
                      <code style={{ background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>{key}</code>
                    </td>
                    <td style={{ padding: '7px 0', color: 'var(--text-muted)' }}>{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', marginBottom: 8 }}>Features</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { icon: '🎯', title: 'One-Click Ship', desc: 'Give one goal — SUNy plans, edits, tests, fixes, and delivers a verified result.' },
                { icon: '📋', title: 'Proof Panel', desc: 'Every task shows exactly what changed, what passed, and what was fixed.' },
                { icon: '⏪', title: 'One-Click Undo', desc: 'Every edit creates a restore point. Roll back any change instantly.' },
                { icon: '🧠', title: 'Code Conscience', desc: 'Design memory remembers your intent across sessions and alerts on drift.' },
                { icon: '💬', title: 'Talk / Write mode', desc: 'Toggle between conversational chat and file-focused code editing.' },
                { icon: '📋', title: 'Project Rules', desc: 'Set persistent instructions SUNy follows in every chat for a project.' },
                { icon: '🎭', title: 'Persona', desc: 'Give SUNy a custom role — e.g. "You are a security expert".' },
                { icon: '⚡', title: 'Auto-Verify', desc: 'SUNy runs tests and lint in a loop until all errors are resolved.' },
                { icon: '📁', title: '@file mentions', desc: 'Type @file:path in any message to reference a file directly.' },
                { icon: '🖥️', title: 'Dev Server', desc: 'Start your dev server from the sidebar and get a clickable URL.' },
                { icon: '🔗', title: 'Secure Bridge', desc: 'Sandboxed bridge connection for safe file operations.' },
                { icon: '🔎', title: 'Symbol Reader', desc: 'Inspect file structure without reading the whole file content.' },
                { icon: '🌐', title: 'URL Fetch', desc: 'SUNy can fetch web pages and docs on demand during tasks.' },
                { icon: '🔧', title: 'Auto-Correction', desc: 'Failed code is analyzed and fixed automatically.' },
                { icon: '🧩', title: 'Subtask Delegation', desc: 'Complex tasks are split into focused sub-tasks with dedicated agents.' },
              ].map(f => (
                <div key={f.title} style={{ display: 'flex', gap: 10 }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>{f.icon}</span>
                  <div>
                    <span style={{ fontWeight: 600, fontSize: 12 }}>{f.title}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}> — {f.desc}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn btn-primary" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  );
}
