import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Plus, Trash2, Settings, LogOut, Square, Eraser, Book, Edit3, RotateCcw, Copy, Check, Pencil, MessageSquare, FileText, X, BarChart2, User } from 'lucide-react';
import BalanceBadge from '../components/BalanceBadge';
import BridgeStatusBadge from '../components/BridgeStatusBadge';
import ModeSelector from '../components/ModeSelector';
import NarratedMessage, { ThinkingIndicator } from '../components/NarratedMessage';
import { useWebSocket } from '../hooks/useWebSocket';

// ── Bridge install instructions (shown inline in the tip popover) ─────────────
function BridgeInstallInstructions() {
  const [cmd, setCmd] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/bridge-token', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.token) return;
        const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const serverUrl = import.meta.env.DEV ? 'ws://localhost:3500' : `${wsProto}://${window.location.host}`;
        const tgzUrl = `${window.location.protocol}//${window.location.host}/bridge/gaby-bridge.tgz`;
        setCmd(`npm install -g ${tgzUrl} && gaby-bridge start --token ${data.token} --server ${serverUrl}`);
      });
  }, []);

  function copy() {
    if (!cmd) return;
    navigator.clipboard.writeText(cmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  return (
    <div style={{ position: 'relative', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 40px 10px 12px', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-primary)', wordBreak: 'break-all', lineHeight: 1.6 }}>
      {cmd || 'Loading...'}
      {cmd && (
        <button
          onClick={copy}
          style={{ position: 'absolute', top: 8, right: 8, background: 'none', border: 'none', cursor: 'pointer', color: copied ? 'var(--success)' : 'var(--text-muted)', padding: 2 }}
          title="Copy command"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      )}
    </div>
  );
}

interface Project {
  id: number;
  name: string;
  local_path: string;
  persona?: string | null;
}

interface Mode {
  mode: string;
  display_name: string;
  session_limit_label: string;
}

interface UserData {
  id: number;
  username: string;
  balance: number;
  wallet_balance: number;
  wallet_auto_spend: boolean;
  selected_mode: string;
  bridge_connected: boolean;
  modes: Mode[];
}

interface Message {
  type: 'user' | 'gaby' | 'system';
  content: string;
  id: number;
}

interface Memory {
  id: string;
  projectId: number;
  title: string;
  summary: string;
  createdAt: number;
  updatedAt: number;
}

interface ChatProps {
  onLogout: () => void;
  onOpenSettings: () => void;
  onBridgeOffline: () => void;
}

export default function Chat({ onLogout, onOpenSettings, onBridgeOffline }: ChatProps) {
  const [userData, setUserData] = useState<UserData | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const streamingContentRef = useRef('');
  const [thinkingStatus, setThinkingStatus] = useState('');
  const [bridgeConnected, setBridgeConnected] = useState(false);
  const [showBridgeTip, setShowBridgeTip] = useState(false);

  // ── Talk / Write mode ────────────────────────────────────────────────────────
  const [talkMode, setTalkMode] = useState<boolean>(() => {
    try { return localStorage.getItem('gaby_talk_mode') === '1'; } catch { return false; }
  });
  function toggleTalkMode() {
    setTalkMode(prev => {
      const next = !prev;
      try { localStorage.setItem('gaby_talk_mode', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  // ── Project Rules (.gaby-rules) ──────────────────────────────────────────────
  const [projectRules, setProjectRules] = useState<string | null>(null);
  const [showRulesEditor, setShowRulesEditor] = useState(false);
  const [rulesEditorContent, setRulesEditorContent] = useState('');

  async function loadProjectRules(projectId: number) {
    try {
      const res = await fetch(`/api/projects/${projectId}/rules`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setProjectRules(data.rules);
      }
    } catch {}
  }

  async function saveProjectRulesApi(content: string) {
    if (!activeProject) return;
    const res = await fetch(`/api/projects/${activeProject.id}/rules`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (res.ok) {
      setProjectRules(content.trim() || null);
      setShowRulesEditor(false);
    }
  }

  // ── Persona per project ──────────────────────────────────────────
  const [showPersonaEditor, setShowPersonaEditor] = useState(false);
  const [personaEditorContent, setPersonaEditorContent] = useState('');

  async function savePersonaApi(content: string) {
    if (!activeProject) return;
    const res = await fetch(`/api/projects/${activeProject.id}/persona`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: content.trim() || null }),
    });
    if (res.ok) {
      setProjects(ps => ps.map(p => p.id === activeProject.id ? { ...p, persona: content.trim() || null } : p));
      setActiveProject(prev => prev ? { ...prev, persona: content.trim() || null } : prev);
      setShowPersonaEditor(false);
    }
  }

  // ── Usage stats ──────────────────────────────────────────────────────────
  interface UsageDay { day: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; charged_cost: number; }
  interface UsageMode { mode: string; input_tokens: number; output_tokens: number; charged_cost: number; }
  interface UsageTotals { input_tokens: number; output_tokens: number; cache_read_tokens: number; charged_cost: number; }
  const [showUsage, setShowUsage] = useState(false);
  const [usageByDay, setUsageByDay] = useState<UsageDay[]>([]);
  const [usageByMode, setUsageByMode] = useState<UsageMode[]>([]);
  const [usageTotals, setUsageTotals] = useState<UsageTotals | null>(null);
  const [usageDays, setUsageDays] = useState(14);

  async function loadUsageStats(days = usageDays) {
    try {
      const res = await fetch(`/api/me/usage?days=${days}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setUsageByDay(data.by_day ?? []);
        setUsageByMode(data.by_mode ?? []);
        setUsageTotals(data.totals ?? null);
      }
    } catch {}
  }

  // ── Checkpoints ──────────────────────────────────────────────────────────────
  interface CheckpointEntry { sha: string; message: string; date: string; }
  const [checkpoints, setCheckpoints] = useState<CheckpointEntry[]>([]);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);

  async function loadCheckpoints(projectId: number) {
    try {
      const res = await fetch(`/api/projects/${projectId}/checkpoints`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setCheckpoints(data.checkpoints ?? []);
      }
    } catch {}
  }

  async function rollbackToCheckpoint(sha: string) {
    if (!activeProject) return;
    setRollingBack(sha);
    try {
      const res = await fetch(`/api/projects/${activeProject.id}/checkpoints/rollback`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha }),
      });
      if (res.ok) {
        await loadCheckpoints(activeProject.id);
      }
    } finally {
      setRollingBack(null);
    }
  }

  // Client-side timeout: if no response within 90s, auto-cancel
  const thinkingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastResponseEvent = useRef(Date.now());

  function clearThinkingTimeout() {
    if (thinkingTimeoutRef.current) {
      clearTimeout(thinkingTimeoutRef.current);
      thinkingTimeoutRef.current = null;
    }
  }

  function resetThinkingTimeout() {
    clearThinkingTimeout();
    lastResponseEvent.current = Date.now();
    thinkingTimeoutRef.current = setTimeout(() => {
      // No response for 90s — cancel and notify
      setThinking(false);
      setStreamingContent('');
      addMessage('system', "GABy seems to be taking longer than expected. Try sending your message again — I'll take it from here! 💪");
    }, 90000);
  }
  const [balance, setBalance] = useState(0);
  const [walletBalance, setWalletBalance] = useState(0);
  const [selectedMode, setSelectedMode] = useState('fast');
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newProjectPathError, setNewProjectPathError] = useState('');
  const msgEndRef = useRef<HTMLDivElement>(null);
  const sessionId = useRef('s_' + Date.now() + '_' + Math.random().toString(36).slice(2));
  const [sessUsed, setSessUsed] = useState(0);
  const [sessLimit, setSessLimit] = useState<number | null>(null);
  let msgId = useRef(0);

  function nextId() { return ++msgId.current; }

  // ── Memory state ─────────────────────────────────────────────────────────────
  const [memories, setMemories] = useState<Memory[]>([]);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [recallingMemory, setRecallingMemory] = useState<Memory | null>(null);

  function memoriesKey(projectId: number) { return `gaby_memories_${projectId}`; }

  function loadMemories(projectId: number): Memory[] {
    try {
      const raw = localStorage.getItem(memoriesKey(projectId));
      if (!raw) return [];
      return JSON.parse(raw) as Memory[];
    } catch { return []; }
  }

  function saveMemories(projectId: number, ms: Memory[]) {
    try { localStorage.setItem(memoriesKey(projectId), JSON.stringify(ms)); } catch {}
  }

  function addMemory(title: string, summary: string) {
    if (!activeProject) return;
    const mem: Memory = {
      id: 'm_' + Date.now(),
      projectId: activeProject.id,
      title,
      summary,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const updated = [mem, ...memories];
    setMemories(updated);
    saveMemories(activeProject.id, updated);
  }

  function deleteMemory(id: string) {
    if (!activeProject) return;
    const updated = memories.filter(m => m.id !== id);
    setMemories(updated);
    saveMemories(activeProject.id, updated);
  }

  function updateMemory(id: string, title: string, summary: string) {
    if (!activeProject) return;
    const updated = memories.map(m =>
      m.id === id ? { ...m, title, summary, updatedAt: Date.now() } : m
    );
    setMemories(updated);
    saveMemories(activeProject.id, updated);
  }

  function recallMemory(mem: Memory) {
    // Insert memory context as a system message, then start fresh
    setMessages([{
      type: 'system',
      content: `📝 Recalled memory: "${mem.title}"\n${mem.summary}`,
      id: nextId(),
    }]);
    setRecallingMemory(null);
  }

  // Load memories when project changes
  useEffect(() => {
    if (activeProject) {
      setMemories(loadMemories(activeProject.id));
      loadProjectRules(activeProject.id);
      loadCheckpoints(activeProject.id);
    } else {
      setProjectRules(null);
      setCheckpoints([]);
    }
  }, [activeProject?.id]);

  // ── localStorage persistence ──────────────────────────────────────────────────
  function storageKey(projectId: number) { return `gaby_chat_${projectId}`; }

  function loadProjectMessages(projectId: number): Message[] {
    try {
      const raw = localStorage.getItem(storageKey(projectId));
      if (!raw) return [];
      return (JSON.parse(raw) as Message[]).slice(-200);
    } catch { return []; }
  }

  function saveProjectMessages(projectId: number, msgs: Message[]) {
    try { localStorage.setItem(storageKey(projectId), JSON.stringify(msgs.slice(-200))); } catch {}
  }

  useEffect(() => {
    if (activeProject) saveProjectMessages(activeProject.id, messages);
  }, [messages, activeProject?.id]);

  const { send: wsSend } = useWebSocket({
    onMessage: (msg) => {
      if (msg.event === 'gaby:narration') {
        if (thinking) {
          // New iteration starting — wipe the previous iteration's streamed text so
          // intermediate tool-call narration doesn't accumulate in the display bubble.
          setStreamingContent('');
          streamingContentRef.current = '';
          // During active processing: show as status in the thinking indicator, not a chat bubble
          setThinkingStatus(msg.message as string);
        } else {
          // Not thinking (error messages, cancel confirmations): add as permanent chat bubble
          clearThinkingTimeout();
          addMessage('gaby', msg.message as string);
        }
      } else if (msg.event === 'gaby:thinking') {
        setThinking(true);
        setThinkingStatus('');
        setStreamingContent('');
        resetThinkingTimeout();
      } else if (msg.event === 'gaby:done') {
        clearThinkingTimeout();
        setThinking(false);
        setThinkingStatus('');
        addMessage('gaby', msg.message as string);
      } else if (msg.event === 'gaby:stream_start') {
        setThinking(true);
        setThinkingStatus('');
        setStreamingContent('');
        resetThinkingTimeout();
      } else if (msg.event === 'gaby:stream_chunk') {
        lastResponseEvent.current = Date.now();
        setStreamingContent(prev => {
          const next = (prev === 'GABy is thinking...' || prev === '') ? (msg.chunk as string) : prev + (msg.chunk as string);
          streamingContentRef.current = next;
          return next;
        });
      } else if (msg.event === 'gaby:stream_end') {
        clearThinkingTimeout();
        setThinking(false);
        setThinkingStatus('');
        // Prefer server-provided final content; fall back to what was streamed live
        const finalContent = (msg.content as string)?.trim() || streamingContentRef.current;
        if (finalContent) addMessage('gaby', finalContent);
        setStreamingContent('');
        streamingContentRef.current = '';
        if (msg.sess_used !== undefined) setSessUsed(msg.sess_used as number);
        if (msg.sess_limit !== undefined) setSessLimit(msg.sess_limit as number | null);
        // Refresh checkpoints after agent turn
        if (activeProject) loadCheckpoints(activeProject.id);
      } else if (msg.event === 'gaby:lint_running') {
        setThinkingStatus(`Running ${msg.command ?? 'linter'}...`);
      } else if (msg.event === 'gaby:lint_errors') {
        setThinkingStatus(`Found ${msg.errorCount} error(s) — fixing (pass ${msg.attempt})...`);
      } else if (msg.event === 'gaby:lint_passed') {
        setThinkingStatus('Lint passed ✓');
      } else if (msg.event === 'gaby:lint_gave_up') {
        // After exhausting retries, surface a warning in the chat
        addMessage('gaby', `⚠️ Completed with ${msg.errorCount} remaining lint error(s). You may want to review the output of \`${msg.command}\`.`);
      } else if (msg.event === 'gaby:balance') {
        setBalance(msg.balance as number);
        if (msg.wallet_balance !== undefined) setWalletBalance(msg.wallet_balance as number);
        if (msg.sess_used !== undefined) setSessUsed(msg.sess_used as number);
        if (msg.sess_limit !== undefined) setSessLimit(msg.sess_limit as number | null);
      } else if (msg.event === 'bridge:connected') {
        clearThinkingTimeout();
        setBridgeConnected(true);
      }
    },
    onConnect: () => {
      // Reset stale state on reconnect — avoids forever-spinning thinking indicator
      clearThinkingTimeout();
      setThinking(false);
      setThinkingStatus('');
      setStreamingContent('');
      streamingContentRef.current = '';
    },
    onDisconnect: () => { setBridgeConnected(false); },
  });

  useEffect(() => { loadUserData(); loadProjects(); return () => clearThinkingTimeout(); }, []);
  useEffect(() => { msgEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, thinking]);

  async function loadUserData() {
    const res = await fetch('/api/me', { credentials: 'include' });
    if (res.ok) {
      const data: UserData = await res.json();
      setUserData(data);
      setBalance(data.balance);
      setWalletBalance(data.wallet_balance);
      setSelectedMode(data.selected_mode);
      setBridgeConnected(data.bridge_connected);
    }
  }

  async function loadProjects() {
    const res = await fetch('/api/projects', { credentials: 'include' });
    if (res.ok) setProjects(await res.json());
  }

  function addMessage(type: 'user' | 'gaby' | 'system', content: string) {
    setMessages(ms => [...ms, { type, content, id: nextId() }]);
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text) return;

    if (balance <= 0 && walletBalance <= 0) {
      addMessage('system', "Looks like you're out of credits! Reach out to us and we'll top you right up 😊");
      return;
    }

    setInput('');
    addMessage('user', text);
    setThinking(true);

    const payload: Record<string, unknown> = {
      type: 'chat:message',
      message: text,
      mode: selectedMode,
      sessionId: sessionId.current,
      talkMode,
      history: messages
        .filter(m => m.type === 'user' || m.type === 'gaby')
        .map(m => ({ role: m.type === 'user' ? 'user' : 'assistant', content: m.content })),
    };
    if (activeProject) payload.projectId = activeProject.id;

    wsSend(payload);
  }

  async function changeMode(mode: string) {
    setSelectedMode(mode);
    await fetch('/api/me/mode', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
  }

  async function createProject() {
    if (!newProjectName.trim() || !newProjectPath.trim()) return;
    const trimmedPath = newProjectPath.trim();
    const isAbsolute = /^[A-Za-z]:[\\//]/.test(trimmedPath) || trimmedPath.startsWith('/');
    if (!isAbsolute) {
      setNewProjectPathError('Please enter the full path to your project folder, like D:\\Projects\\MyApp');
      return;
    }
    setNewProjectPathError('');
    const res = await fetch('/api/projects', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newProjectName.trim(), local_path: trimmedPath }),
    });
    if (res.ok) {
      await loadProjects();
      setShowNewProject(false);
      setNewProjectName('');
      setNewProjectPath('');
      setNewProjectPathError('');
    } else {
      const data = await res.json().catch(() => ({}));
      const msg = data?.details?.fieldErrors?.local_path?.[0] || data?.error || 'Failed to create project';
      setNewProjectPathError(msg);
    }
  }

  async function deleteProject(id: number) {
    await fetch(`/api/projects/${id}`, { method: 'DELETE', credentials: 'include' });
    setProjects(ps => ps.filter(p => p.id !== id));
    if (activeProject?.id === id) setActiveProject(null);
  }

  function clearChat() {
    // Save conversation as a memory before clearing
    if (activeProject && messages.length > 0) {
      const userMsgs = messages.filter(m => m.type === 'user').map(m => m.content);
      const lastUserMsg = userMsgs[userMsgs.length - 1] || '';
      const title = lastUserMsg.length > 60 ? lastUserMsg.slice(0, 57) + '…' : (lastUserMsg || 'Chat session');
      // Build a compact summary: last user message + count of messages
      const summary = `${messages.length} messages · Last asked: "${lastUserMsg.slice(0, 120)}"`;
      addMemory(title, summary);
    }
    setMessages([]);
    setThinking(false);
    setStreamingContent('');
    streamingContentRef.current = '';
    clearThinkingTimeout();
    setSessUsed(0);
    sessionId.current = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    setThinkingStatus('');
    if (activeProject) localStorage.removeItem(storageKey(activeProject.id));
  }

  async function handleLogout() {
    await fetch('/api/logout', { method: 'POST', credentials: 'include' });
    onLogout();
  }

  const modes = userData?.modes || [];
  const noBalance = balance <= 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)' }}>
      {/* Top bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        height: 52,
        borderBottom: '1px solid var(--border)',
        gap: 12,
        flexShrink: 0,
      }}>
        <img src="/GABy.png" alt="GABy" style={{ width: 52, height: 52, borderRadius: '50%', objectFit: 'cover' }} />
        <span style={{ fontWeight: 700, fontSize: 18, color: 'var(--accent)', marginRight: 4 }}>GABy</span>
        {activeProject && (
          <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>· {activeProject.name}</span>
        )}
        <div style={{ flex: 1 }} />
        {activeProject && messages.length > 0 && (
          <button className="btn btn-icon btn-secondary" onClick={clearChat} title="Clear chat">
            <Eraser size={15} />
          </button>
        )}
        {modes.length > 0 && (
          <ModeSelector modes={modes} selected={selectedMode} onChange={changeMode} />
        )}
        <BridgeStatusBadge
          connected={bridgeConnected}
          onClick={() => setShowBridgeTip(t => !t)}
        />
        <BalanceBadge balance={balance} walletBalance={walletBalance} />
        <button
          className="btn btn-icon btn-secondary"
          onClick={() => { setShowUsage(true); loadUsageStats(usageDays); }}
          title="Usage stats"
        >
          <BarChart2 size={15} />
        </button>
        <button className="btn btn-icon btn-secondary" onClick={onOpenSettings} title="Settings">
          <Settings size={15} />
        </button>
        <button className="btn btn-icon btn-secondary" onClick={handleLogout} title="Sign out">
          <LogOut size={15} />
        </button>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Projects sidebar */}
        <div style={{
          width: 220,
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          padding: '12px 0',
          flexShrink: 0,
        }}>
          <div style={{ padding: '0 12px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Projects
            </span>
            <button className="btn btn-icon btn-secondary btn-sm" onClick={() => setShowNewProject(true)} title="New project">
              <Plus size={13} />
            </button>
          </div>

          {projects.map(p => (
            <div
              key={p.id}
              onClick={() => {
                // Save current project's messages before switching
                if (activeProject && messages.length > 0) {
                  saveProjectMessages(activeProject.id, messages);
                }
                setActiveProject(p);
                setMessages(loadProjectMessages(p.id));
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                cursor: 'pointer',
                background: activeProject?.id === p.id ? 'rgba(108,99,255,0.1)' : 'transparent',
                borderLeft: activeProject?.id === p.id ? '2px solid var(--accent)' : '2px solid transparent',
              }}
            >
              <span style={{
                fontSize: 13,
                color: activeProject?.id === p.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}>
                {p.name}
              </span>
              <button
                className="btn btn-icon btn-sm"
                onClick={e => { e.stopPropagation(); deleteProject(p.id); }}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', padding: 2 }}
                title="Remove project"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}

          {projects.length === 0 && (
            <p style={{ padding: '0 12px', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              No projects yet. Click + to add one.
            </p>
          )}

          {/* Memories section */}
          {activeProject && (
            <>
              <div style={{
                padding: '16px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                borderTop: '1px solid var(--border)', marginTop: 4,
              }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Memories
                </span>
                {memories.length > 0 && (
                  <button
                    className="btn btn-icon btn-sm"
                    onClick={() => setMemories([])}
                    title="Clear all memories"
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', padding: 2, cursor: 'pointer', fontSize: 10 }}
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>

              {memories.length === 0 && (
                <p style={{ padding: '0 12px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, marginTop: 4 }}>
                  Clear a chat to save it here.
                </p>
              )}

              <div style={{ overflow: 'auto', maxHeight: 240 }}>
                {memories.map(m => (
                  <div
                    key={m.id}
                    style={{
                      padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)',
                      transition: 'background 0.15s',
                    }}
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

          {/* Project Rules (.gaby-rules) section */}
          {activeProject && (
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
              <div style={{ padding: '12px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
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
              {projectRules ? (
                <div style={{ padding: '0 12px 8px', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 100, overflowY: 'auto', opacity: 0.8 }}>
                  {projectRules.slice(0, 300)}{projectRules.length > 300 ? '…' : ''}
                </div>
              ) : (
                <p style={{ padding: '0 12px 8px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  No rules set. Click ✏️ to add coding guidelines for this project.
                </p>
              )}
            </div>
          )}

          {/* Persona section */}
          {activeProject && (
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
              <div style={{ padding: '12px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
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
              {activeProject.persona ? (
                <div style={{ padding: '0 12px 8px', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 70, overflowY: 'auto', opacity: 0.8 }}>
                  {activeProject.persona.slice(0, 200)}{(activeProject.persona?.length ?? 0) > 200 ? '…' : ''}
                </div>
              ) : (
                <p style={{ padding: '0 12px 8px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  No persona. Click 👤 to give GABy a role for this project.
                </p>
              )}
            </div>
          )}

          {/* Checkpoints section */}
          {activeProject && checkpoints.length > 0 && (
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
              <div style={{ padding: '12px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Checkpoints
                </span>
                <button
                  className="btn btn-icon btn-sm"
                  onClick={() => loadCheckpoints(activeProject.id)}
                  title="Refresh checkpoints"
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', padding: 2, cursor: 'pointer', fontSize: 10 }}
                >
                  ↻
                </button>
              </div>
              <div style={{ overflowY: 'auto', maxHeight: 180 }}>
                {checkpoints.map(cp => (
                  <div key={cp.sha} style={{ padding: '6px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {cp.message.replace('GABy checkpoint: ', '')}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, fontFamily: 'JetBrains Mono, monospace' }}>
                        {cp.sha.slice(0, 7)}
                      </div>
                    </div>
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => rollbackToCheckpoint(cp.sha)}
                      disabled={rollingBack === cp.sha}
                      title="Roll back to this checkpoint"
                      style={{ fontSize: 10, padding: '2px 6px', flexShrink: 0, marginLeft: 6 }}
                    >
                      {rollingBack === cp.sha ? '…' : 'Restore'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Chat area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Messages */}
          <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
        {activeProject && messages.length > 0 && (
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
              <div style={{ textAlign: 'center', marginTop: 80, color: 'var(--text-muted)' }}>
                <p style={{ fontSize: 32, marginBottom: 12 }}>💻</p>
                <p style={{ fontWeight: 600, marginBottom: 8 }}>Select or create a project</p>
                <p style={{ fontSize: 13 }}>Pick a project from the sidebar to get file access, or just start chatting below!</p>
              </div>
            )}

            {activeProject && messages.length === 0 && !thinking && (
              <div style={{ textAlign: 'center', marginTop: 40, color: 'var(--text-muted)' }}>
                <img src="/GABy.png" alt="GABy" style={{ width: 280, height: 280, borderRadius: '50%', objectFit: 'cover', marginBottom: 20, boxShadow: '0 8px 32px rgba(108,99,255,0.25)' }} />
                <p style={{ fontWeight: 700, fontSize: 22, marginBottom: 10, color: 'var(--text-primary)' }}>Hi! I'm GABy</p>
                <p style={{ fontSize: 14 }}>Tell me what you'd like to build or fix. I'll take it from there!</p>
                {!bridgeConnected && (
                  <p style={{ fontSize: 12, marginTop: 8, color: 'var(--text-muted)' }}>
                    🔗 Connect the bridge (top bar) to unlock file editing, shell commands, and more.
                  </p>
                )}
              </div>
            )}

            {messages.map(m => (
              <NarratedMessage key={m.id} message={m.content} type={m.type} />
            ))}
            {thinking && streamingContent && (
              <>
                <NarratedMessage message={streamingContent} type="gaby" />
                {thinkingStatus && (
                  <div style={{
                    display: 'flex', gap: 8, marginLeft: 38, marginBottom: 12,
                    alignItems: 'center', fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic',
                  }}>
                    <span style={{
                      display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                      background: 'var(--accent)', opacity: 0.7, flexShrink: 0,
                    }} />
                    {thinkingStatus}
                  </div>
                )}
              </>
            )}
            {thinking && !streamingContent && <ThinkingIndicator statusText={thinkingStatus} />}
            <div ref={msgEndRef} />
          </div>

          {/* Input — always visible */}
          <div style={{
              padding: '12px 20px 16px',
              borderTop: '1px solid var(--border)',
              display: 'flex',
              gap: 10,
              alignItems: 'flex-end',
            }}>
              {balance <= 0 && walletBalance <= 0 && !thinking ? (
                <div style={{
                  flex: 1,
                  padding: '12px 16px',
                  borderRadius: 'var(--radius)',
                  background: 'rgba(248,113,113,0.1)',
                  border: '1px solid var(--error)',
                  color: 'var(--error)',
                  fontSize: 13,
                  textAlign: 'center',
                }}>
                  Looks like you're out of credits! Reach out to us and we'll top you right up 😊
                </div>
              ) : (
                <>
                  <textarea
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    placeholder={thinking ? 'GABy is working...' : activeProject && !bridgeConnected ? 'Bridge offline — I can still reason, explain, and review code! Type your question...' : 'Type your goal here... e.g. Add a dark mode toggle to my app'}
                    rows={2}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey && !thinking) { e.preventDefault(); sendMessage(); }
                    }}
                    style={{ flex: 1, resize: 'none', maxHeight: 120 }}
                    disabled={thinking}
                  />
                  {/* Talk / Write mode toggle */}
                  <button
                    className="btn btn-icon btn-secondary"
                    onClick={toggleTalkMode}
                    title={talkMode ? 'Talk Mode — no file changes (click to switch to Write Mode)' : 'Write Mode — full file editing (click to switch to Talk Mode)'}
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
                    <button
                      className="btn btn-primary"
                      onClick={sendMessage}
                      disabled={!input.trim()}
                      style={{ padding: '10px 16px', alignSelf: 'flex-end' }}
                    >
                      <Send size={15} />
                    </button>
                  )}
                </>)
              }
            </div>
        </div>
      </div>

      {/* Bridge tip popover */}
      {showBridgeTip && (
        <div className="modal-overlay" onClick={() => setShowBridgeTip(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <h3 className="modal-title">🔗 GABy Bridge</h3>
            {bridgeConnected ? (
              <>
                <p style={{ fontSize: 14, color: 'var(--success)', marginBottom: 12, fontWeight: 600 }}>✓ Bridge is connected!</p>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  GABy has full access to your project — it can read &amp; write files, run shell commands, execute the linter, and auto-commit to git.
                </p>
              </>
            ) : (
              <>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 12 }}>
                  <strong>Bridge is offline.</strong> You can still use GABy for reasoning, code review, architecture questions, and general chat.
                  <br /><br />
                  To unlock <strong>file editing, shell commands, lint self-correction, and git auto-commit</strong>, install and start the bridge on your machine:
                </p>
                <BridgeInstallInstructions />
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>
                  Once started, this badge turns green automatically — no refresh needed.
                </p>
              </>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-primary" onClick={() => setShowBridgeTip(false)}>Got it</button>
            </div>
          </div>
        </div>
      )}

      {/* Recall Memory Modal */}
      {recallingMemory && (
        <div className="modal-overlay" onClick={() => setRecallingMemory(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">Recall Memory</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>Insert this memory into a fresh chat?</p>
            <div style={{ background: 'var(--bg)', padding: 12, borderRadius: 'var(--radius)', marginBottom: 16 }}>
              <p style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{recallingMemory.title}</p>
              <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{recallingMemory.summary}</p>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setRecallingMemory(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => recallMemory(recallingMemory)}>
                <RotateCcw size={14} style={{ marginRight: 6 }} />Recall
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Memory Modal */}
      {editingMemory && (
        <div className="modal-overlay" onClick={() => setEditingMemory(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">Edit Memory</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Title</label>
                <input value={editTitle} onChange={e => setEditTitle(e.target.value)} autoFocus />
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Summary</label>
                <textarea
                  value={editSummary}
                  onChange={e => setEditSummary(e.target.value)}
                  rows={3}
                  style={{ width: '100%', resize: 'vertical' }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setEditingMemory(null)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  if (editingMemory && editTitle.trim()) {
                    updateMemory(editingMemory.id, editTitle.trim(), editSummary.trim());
                    setEditingMemory(null);
                  }
                }}
                disabled={!editTitle.trim()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Project Rules Editor Modal */}
      {showRulesEditor && activeProject && (
        <div className="modal-overlay" onClick={() => setShowRulesEditor(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <h3 className="modal-title">
              <FileText size={16} style={{ marginRight: 8, verticalAlign: 'text-bottom' }} />
              Project Rules — {activeProject.name}
            </h3>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
              These rules are saved to <code style={{ background: 'var(--bg)', padding: '1px 4px', borderRadius: 3 }}>.gaby-rules</code> in your project folder and injected into every conversation for this project.
              <br />Write coding preferences, forbidden patterns, naming conventions, or anything GABy should always follow.
            </p>
            <textarea
              value={rulesEditorContent}
              onChange={e => setRulesEditorContent(e.target.value)}
              placeholder={"# Project Rules\n\n- Use TypeScript strict mode\n- Prefer functional components\n- All API routes must be RESTful\n- Never use console.log in production code"}
              rows={12}
              autoFocus
              style={{ width: '100%', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowRulesEditor(false)}>Cancel</button>
              {projectRules && (
                <button
                  className="btn btn-secondary"
                  style={{ color: 'var(--error)', borderColor: 'var(--error)' }}
                  onClick={async () => {
                    await fetch(`/api/projects/${activeProject.id}/rules`, { method: 'DELETE', credentials: 'include' });
                    setProjectRules(null);
                    setShowRulesEditor(false);
                  }}
                >
                  <Trash2 size={13} style={{ marginRight: 6 }} />Delete Rules
                </button>
              )}
              <button
                className="btn btn-primary"
                onClick={() => saveProjectRulesApi(rulesEditorContent)}
              >
                Save Rules
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New Project Modal */}
      {showNewProject && (
        <div className="modal-overlay" onClick={() => setShowNewProject(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">New Project</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Project Name</label>
                <input
                  value={newProjectName}
                  onChange={e => setNewProjectName(e.target.value)}
                  placeholder="My Awesome App"
                  autoFocus
                />
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>📁 Project Folder</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={newProjectPath}
                    onChange={e => { setNewProjectPath(e.target.value); setNewProjectPathError(''); }}
                    placeholder="e.g. C:\\Users\\me\\projects\\my-app"
                    style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, flex: 1, borderColor: newProjectPathError ? 'var(--color-error, #e74c3c)' : undefined }}
                  />
                  <label className="btn btn-secondary" style={{ cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: 0 }} title="Browse for folder">
                    📁 Browse
                    <input
                      type="file"
                      // @ts-ignore
                      webkitdirectory=""
                      style={{ display: 'none' }}
                      onChange={e => {
                        const files = e.target.files;
                        if (files && files.length > 0) {
                          // Electron exposes .path; browsers only give webkitRelativePath
                          const fullPath = (files[0] as any).path as string | undefined;
                          if (fullPath) {
                            const parts = fullPath.replace(/\\/g, '/').split('/');
                            parts.pop();
                            setNewProjectPath(parts.join('\\') || fullPath);
                          } else {
                            // Extract folder name from webkitRelativePath (browser fallback)
                            const rel = files[0].webkitRelativePath || '';
                            const folderName = rel.split('/')[0];
                            if (folderName) setNewProjectPath(folderName);
                          }
                        }
                      }}
                    />
                  </label>
                </div>
                {newProjectPathError && (
                  <div style={{ fontSize: 12, color: 'var(--color-error, #e74c3c)', marginTop: 4 }}>
                    {newProjectPathError}
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  This is the folder on your computer where GABy will work.
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowNewProject(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={createProject}>Create Project</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
