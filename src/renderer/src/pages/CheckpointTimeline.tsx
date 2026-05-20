import { useState, useEffect } from 'react';
import { Clock, RotateCcw, ArrowLeft, Tag, FileText, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface CheckpointRecord {
  id: number;
  user_id: number;
  project_id: number | null;
  session_id: string | null;
  sha: string;
  label: string;
  tags: string;
  files_changed: number;
  turn_index: number;
  metadata_json: string;
  created_at: string;
  gitSha?: string;
  filesChanged?: number;
}

interface Project {
  id: number;
  name: string;
  local_path: string;
}

export default function CheckpointTimeline() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [timeline, setTimeline] = useState<CheckpointRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [rollingBack, setRollingBack] = useState<number | null>(null);
  const [expandedCp, setExpandedCp] = useState<number | null>(null);

  useEffect(() => { loadProjects(); }, []);

  async function loadProjects() {
    try {
      const res = await fetch('/api/projects', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects ?? []);
        if (data.projects?.length > 0 && !selectedProjectId) {
          setSelectedProjectId(data.projects[0].id);
        }
      }
    } catch {}
  }

  useEffect(() => {
    if (selectedProjectId) loadTimeline(selectedProjectId);
  }, [selectedProjectId]);

  async function loadTimeline(projectId: number) {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/checkpoints/timeline/${projectId}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setTimeline(data.timeline ?? []);
      } else {
        setError('Failed to load checkpoint timeline');
      }
    } catch {
      setError('Network error');
    }
    setLoading(false);
  }

  async function rollbackToCp(id: number) {
    setRollingBack(id);
    setError('');
    try {
      const res = await fetch(`/api/checkpoints/rollback/${id}`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        if (selectedProjectId) loadTimeline(selectedProjectId);
      } else {
        setError(data.message || 'Rollback failed');
      }
    } catch {
      setError('Network error during rollback');
    }
    setRollingBack(null);
  }

  function formatDate(dateStr: string): string {
    try {
      return new Date(dateStr).toLocaleString();
    } catch { return dateStr; }
  }

  function getTagColor(tag: string): string {
    const map: Record<string, string> = {
      auto: 'var(--text-muted)',
      manual: 'var(--accent)',
      'turn-checkpoint': '#6cc',
      milestone: '#d4ff4f',
      rollback: 'var(--error)',
    };
    return map[tag] ?? 'var(--text-secondary)';
  }

  const selectedProject = projects.find(p => p.id === selectedProjectId);

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button className="btn btn-icon btn-secondary" onClick={() => navigate('/')} title="Back to chat">
          <ArrowLeft size={18} />
        </button>
        <Clock size={22} style={{ color: 'var(--accent)' }} />
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Checkpoint Timeline</h1>
      </div>

      {/* Project selector */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20 }}>
        <select
          value={selectedProjectId ?? ''}
          onChange={e => setSelectedProjectId(parseInt(e.target.value, 10) || null)}
          style={{
            flex: 1, maxWidth: 400, padding: '8px 12px',
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 6, color: 'var(--text-primary)', fontSize: 14,
          }}
        >
          {projects.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <button className="btn btn-icon btn-secondary" onClick={() => selectedProjectId && loadTimeline(selectedProjectId)} title="Refresh">
          <RefreshCw size={16} />
        </button>
      </div>

      {error && (
        <div style={{ padding: '10px 14px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, marginBottom: 16, color: 'var(--text-primary)', fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Timeline */}
      {loading ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: 14, padding: 20 }}>Loading timeline...</div>
      ) : timeline.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 14, fontStyle: 'italic', padding: 20 }}>
          {selectedProject
            ? `No checkpoints found for "${selectedProject.name}". Checkpoints are created automatically during agent runs.`
            : 'Select a project to view its checkpoint timeline.'}
        </div>
      ) : (
        <div style={{ position: 'relative' }}>
          {/* Timeline line */}
          <div style={{
            position: 'absolute', left: 22, top: 0, bottom: 0, width: 2,
            background: 'var(--border)', zIndex: 0,
          }} />

          {timeline.map((cp, idx) => {
            const tags = cp.tags ? cp.tags.split(',').filter(Boolean) : [];
            const isExpanded = expandedCp === cp.id;
            let metadata: Record<string, unknown> = {};
            try { metadata = JSON.parse(cp.metadata_json || '{}'); } catch {}

            return (
              <div key={cp.id} style={{ position: 'relative', zIndex: 1, marginBottom: 12, paddingLeft: 48 }}>
                {/* Timeline dot */}
                <div style={{
                  position: 'absolute', left: 14, top: 16, width: 18, height: 18, borderRadius: '50%',
                  background: idx === 0 ? 'var(--accent)' : 'var(--surface)',
                  border: `3px solid ${idx === 0 ? 'var(--accent)' : 'var(--border)'}`,
                  boxShadow: '0 0 0 3px var(--bg)',
                }} />

                {/* Card */}
                <div style={{
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 8, padding: 14,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 14, fontWeight: 600, color: 'var(--text-primary)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {cp.label}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                        <span title="Git SHA">
                          <code style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--accent)' }}>{cp.sha.slice(0, 7)}</code>
                        </span>
                        <span>{formatDate(cp.created_at)}</span>
                        <span>Turn #{cp.turn_index}</span>
                        {cp.files_changed > 0 && (
                          <span><FileText size={12} style={{ verticalAlign: 'middle', marginRight: 3 }} />{cp.files_changed} files</span>
                        )}
                      </div>
                      {/* Tags */}
                      {tags.length > 0 && (
                        <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                          {tags.map(tag => (
                            <span key={tag} style={{
                              fontSize: 10, padding: '1px 6px', borderRadius: 3,
                              border: `1px solid ${getTagColor(tag)}`,
                              color: getTagColor(tag), fontWeight: 500,
                            }}>
                              <Tag size={9} style={{ verticalAlign: 'middle', marginRight: 2 }} />
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      <button
                        className="btn btn-icon btn-sm btn-secondary"
                        onClick={() => setExpandedCp(isExpanded ? null : cp.id)}
                        title="Show details"
                      >
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => rollbackToCp(cp.id)}
                        disabled={rollingBack === cp.id}
                        style={{ fontSize: 11 }}
                      >
                        <RotateCcw size={12} />
                        {rollingBack === cp.id ? '...' : 'Restore'}
                      </button>
                    </div>
                  </div>

                  {/* Expanded details */}
                  {isExpanded && (
                    <div style={{
                      marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)',
                      fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6,
                    }}>
                      {Object.keys(metadata).length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <strong>Metadata:</strong>
                          <pre style={{
                            margin: '4px 0', padding: 8, background: 'var(--bg)',
                            borderRadius: 4, fontSize: 11, overflowX: 'auto',
                          }}>
                            {JSON.stringify(metadata, null, 2)}
                          </pre>
                        </div>
                      )}
                      {cp.session_id && (
                        <div>Session: <code>{cp.session_id}</code></div>
                      )}
                      {cp.project_id && (
                        <div>Project ID: {cp.project_id}</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
