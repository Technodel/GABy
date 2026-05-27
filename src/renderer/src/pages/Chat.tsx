import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, Trash2, Settings, LogOut, Edit3, RotateCcw, X, BarChart2, User, HelpCircle, Sparkles, Home, Eraser, Phone, ChevronRight, ChevronDown, FolderOpen, Folder, Play, FileText, GitBranch, Archive, ArchiveRestore, Link, Check, Rocket, ShieldCheck, Undo, Brain, MessageSquare, BookOpen, CheckCircle, Lock, Eye, Globe, Wrench, Users } from 'lucide-react';

import ReportBadgeButton, { ReportMetrics } from '../components/ReportBadgeButton';
import { registerServiceWorker, requestNotificationPermission, sendRunReceipt, notificationsSupported, notificationsGranted } from '../lib/push-notifications';
import { useWebSocket } from '../hooks/useWebSocket';
import { useNavigate } from 'react-router-dom';
import BalanceBadge from '../components/BalanceBadge';
import ModeSelector from '../components/ModeSelector';
import BridgeInstallInstructions from '../components/BridgeInstallInstructions';
import BridgeStatusBadge from '../components/BridgeStatusBadge';
import TopBar from '../components/TopBar';
import SidebarContent from '../components/SidebarContent';
import ChatMessages from '../components/ChatMessages';
import ChatInput from '../components/ChatInput';
import FileTreeNode from '../components/FileTreeNode';
import type { Project, ProjectSpend, Mode, UserData, Message, Memory, ProofRun, ChatProps } from '../types';

// ── Upgrade to PRO button ────────────────────────────────────────────────────
function UpgradePROButton({ plan, upgradePending }: { plan?: string; upgradePending?: boolean }) {
  const [state, setState] = React.useState<'idle'|'loading'|'sent'|'error'>(() => upgradePending ? 'sent' : 'idle');
  React.useEffect(() => { if (upgradePending && state === 'idle') setState('sent'); }, [upgradePending]);
  if (plan && plan !== 'regular') return null;
  return (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, flexShrink: 0 }}>
    <button
      onClick={async () => {
        if (state !== 'idle') return;
        setState('loading');
        try {
          const res = await fetch('/api/upgrade-request', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: '' }),
          });
          const data = await res.json() as { success?: boolean };
          if (res.ok && data.success) { setState('sent'); }
          else { setState('error'); setTimeout(() => setState('idle'), 3000); }
        } catch { setState('error'); setTimeout(() => setState('idle'), 3000); }
      }}
      disabled={state === 'loading' || state === 'sent'}
      title={state === 'sent' ? 'Upgrade request sent! Admin will review it.' : 'Upgrade your account to PRO'}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(108,99,255,0.5)',
        background: state === 'sent' ? 'rgba(34,197,94,0.12)' : 'rgba(108,99,255,0.12)',
        color: state === 'sent' ? 'var(--success,#22c55e)' : 'var(--accent)',
        cursor: state === 'loading' || state === 'sent' ? 'default' : 'pointer',
        fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', transition: 'all 0.2s',
        flexShrink: 0,
      }}
    >
      {state === 'loading' ? '...' : state === 'sent' ? '✓ Request Sent' : '⚡ Upgrade to PRO'}
    </button>
    <a
      href="/pro-features"
      target="_blank"
      rel="noreferrer"
      style={{ fontSize: 9, color: 'var(--text-muted)', textAlign: 'center', textDecoration: 'none', marginTop: 1, lineHeight: 1 }}
      onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
      onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
    >
      Why PRO?
    </a>
  </div>
  );
}

// -- File browser tree node --------------------------------------------------
export default function Chat({ onLogout, onOpenSettings, onBridgeOffline }: ChatProps) {
  const navigate = useNavigate();
  const [userData, setUserData] = useState<UserData | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectSpend, setProjectSpend] = useState<Record<number, ProjectSpend>>({});
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const streamingContentRef = useRef('');
  const [thinkingStatus, setThinkingStatus] = useState('');
  const [bridgeConnected, setBridgeConnected] = useState(false);
  const [bridgePreviouslyConnected, setBridgePreviouslyConnected] = useState(false);
  const [showBridgeTip, setShowBridgeTip] = useState(false);
  const [showTopUp, setShowTopUp] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState('5');
  const [topUpNote, setTopUpNote] = useState('');
  const [topUpSubmitting, setTopUpSubmitting] = useState(false);
  const [topUpResult, setTopUpResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [crossDeviceMemoryEnabled, setCrossDeviceMemoryEnabled] = useState(false);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);
  const [globalAutoApprove, setGlobalAutoApprove] = useState(true);
  const [projectStateReady, setProjectStateReady] = useState(false);
  const [globalIntroLine, setGlobalIntroLine] = useState('');

  const [checkpoint, setCheckpoint] = useState<{ label: string; details: string } | null>(null);
  const [forecastEstimate, setForecastEstimate] = useState<{
    lowCredits: number; highCredits: number; historicalSamples: number;
    estimatedSteps: number; confidence: string; basedOn: string;
    currentBalance: number; mode: string;
  } | null>(null);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [budgetWarning, setBudgetWarning] = useState<{ spent: number; cap: number; pct: number } | null>(null);
  const [budgetGateOpen, setBudgetGateOpen] = useState<{ spent: number; cap: number } | null>(null);
  const [budgetExtendInput, setBudgetExtendInput] = useState('');
  const [notifyOnComplete, setNotifyOnComplete] = useState(() => {
    try { return localStorage.getItem('suny_notify_on_complete') === 'true'; } catch { return false; }
  });
  const lastUserMessageRef = useRef<string>('');
  const [queuedPrompt, setQueuedPrompt] = useState<{ text: string; payload: any; status: 'queued' | 'interrupting'; timeLeft: number } | null>(null);
  const queueTimerRef = useRef<number | null>(null);

  // -- Queued Prompt Handling --
  useEffect(() => {
    if (queuedPrompt && queuedPrompt.status === 'interrupting') {
      if (queuedPrompt.timeLeft <= 0) {
        // Time's up -> abort current and send
        wsSend({ type: 'chat:cancel' });
        setTimeout(() => {
          wsSend(queuedPrompt.payload);
          setImagePreview(null);
          setQueuedPrompt(null);
        }, 300);
      } else {
        queueTimerRef.current = window.setTimeout(() => {
          setQueuedPrompt(prev => prev ? { ...prev, timeLeft: prev.timeLeft - 1 } : null);
        }, 1000);
      }
    }
    return () => {
      if (queueTimerRef.current) clearTimeout(queueTimerRef.current);
    };
  }, [queuedPrompt]);

  useEffect(() => {
    // If thinking finishes and we have a queued prompt, send it automatically
    if (!thinking && queuedPrompt && queuedPrompt.status === 'queued') {
      wsSend(queuedPrompt.payload);
      setImagePreview(null);
      setQueuedPrompt(null);
    }
  }, [thinking, queuedPrompt]);

  // -- Talk / Write mode --------------------------------------------------------
  const [talkMode, setTalkMode] = useState<boolean>(() => {
    try { return localStorage.getItem('suny_talk_mode') === '1'; } catch { return false; }
  });
  function toggleTalkMode() {
    setTalkMode(prev => {
      const next = !prev;
      try { localStorage.setItem('suny_talk_mode', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  // -- Voice input (Web Speech API) -----------------------------------------
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  function toggleVoice() {
    const SpeechRec = (window as Record<string, unknown>).SpeechRecognition as (typeof SpeechRecognition | undefined)
      ?? (window as Record<string, unknown>).webkitSpeechRecognition as (typeof SpeechRecognition | undefined);
    if (!SpeechRec) {
      addMessage('system', '?? Voice input is not supported in this browser. Try Chrome or Edge.');
      return;
    }
    if (isListening && recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }
    const rec = new SpeechRec();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = 'en-US';
    rec.onstart = () => setIsListening(true);
    rec.onend = () => setIsListening(false);
    rec.onerror = () => setIsListening(false);
    rec.onresult = (e: SpeechRecognitionEvent) => {
      const transcript = Array.from(e.results).slice(e.resultIndex)
        .map(r => r[0].transcript).join('');
      setInput(prev => (prev ? prev + ' ' : '') + transcript);
    };
    recognitionRef.current = rec;
    rec.start();
  }

  // -- Adaptive routing -----------------------------------------------------
  const [routingReason, setRoutingReason] = useState<string | null>(null);
  const [resolvedMode, setResolvedMode] = useState<string>('fast');

  function routingIcon(mode: string): string {
    const icons: Record<string, string> = {
      'auto': 'AUTO',
      'free': 'FREE',
      'fast': 'FAST',
      'smart': 'SMART',
      'pro': 'PRO',
    };
    return icons[mode] ?? 'MODE';
  }

  function normalizeReport(report: unknown): ReportMetrics | undefined {
    if (!report || typeof report !== 'object') return undefined;
    const value = report as Partial<ReportMetrics>;
    if (typeof value.durationMs !== 'number') return undefined;
    const inputTokens = typeof value.inputTokens === 'number' ? value.inputTokens : 0;
    const outputTokens = typeof value.outputTokens === 'number' ? value.outputTokens : 0;
    const cacheWriteTokens = typeof value.cacheWriteTokens === 'number' ? value.cacheWriteTokens : 0;
    const cacheReadTokens = typeof value.cacheReadTokens === 'number' ? value.cacheReadTokens : 0;
    return {
      durationMs: value.durationMs,
      totalTokens: typeof value.totalTokens === 'number' ? value.totalTokens : inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens,
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      chargedCost: typeof value.chargedCost === 'number' ? value.chargedCost : 0,
      humanEstimateMinutes: typeof value.humanEstimateMinutes === 'number' ? value.humanEstimateMinutes : 0,
      humanEstimateCost: typeof value.humanEstimateCost === 'number' ? value.humanEstimateCost : 0,
      messageCount: typeof value.messageCount === 'number' ? value.messageCount : undefined,
    };
  }

  function normalizeMessage(raw: Partial<Message>, index: number): Message {
    return {
      id: typeof raw.id === 'number' ? raw.id : index + 1,
      type: raw.type === 'user' ? 'user' : raw.type === 'suny' ? 'suny' : raw.type === 'system' ? 'system' : 'system',
      content: typeof raw.content === 'string' ? raw.content : '',
      timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now() - ((index + 1) * 1000),
      report: normalizeReport(raw.report),
    };
  }

  // -- Sound effects ---------------------------------------------------------
  // Read soundsEnabled from localStorage on each call so Settings changes take effect immediately
  function soundsEnabled(): boolean {
    try { return localStorage.getItem('suny_sounds_enabled') !== 'false'; } catch { return true; }
  }

  // Shared AudioContext � persisted via useRef so it survives re-renders.
  // Browser autoplay policy suspends new AudioContexts not created from user gestures.
  // We resume on first user interaction (keydown/mousedown) so sounds from WebSocket
  // events (not user gestures) still play.
  const sharedCtxRef = useRef<AudioContext | null>(null);
  const ctxResumedRef = useRef(false);

  function getAudioContext(): AudioContext {
    if (!sharedCtxRef.current) {
      sharedCtxRef.current = new AudioContext();
    }
    // Attempt resume if still suspended (will work once user has interacted)
    if (!ctxResumedRef.current && sharedCtxRef.current.state === 'suspended') {
      sharedCtxRef.current.resume().then(() => { ctxResumedRef.current = true; }).catch(() => {});
    }
    return sharedCtxRef.current;
  }

  // Bootstrap: resume AudioContext on first user gesture
  useEffect(() => {
    function onUserGesture() {
      if (sharedCtxRef.current && sharedCtxRef.current.state === 'suspended') {
        sharedCtxRef.current.resume().then(() => { ctxResumedRef.current = true; }).catch(() => {});
      }
    }
    window.addEventListener('keydown', onUserGesture, { once: true });
    window.addEventListener('mousedown', onUserGesture, { once: true });
    return () => {
      window.removeEventListener('keydown', onUserGesture);
      window.removeEventListener('mousedown', onUserGesture);
    };
  }, []);

  function playSound(type: 'send' | 'receive' | 'tool' | 'success' | 'error') {
    if (!soundsEnabled()) return;
    try {
      const ctx = getAudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      const now = ctx.currentTime;
      osc.type = 'square';
      switch (type) {
        case 'send':
          osc.frequency.setValueAtTime(880, now);
          osc.frequency.exponentialRampToValueAtTime(1320, now + 0.06);
          gain.gain.setValueAtTime(0.04, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
          osc.start(now); osc.stop(now + 0.12);
          break;
        case 'receive':
          osc.frequency.setValueAtTime(440, now);
          osc.frequency.linearRampToValueAtTime(660, now + 0.07);
          osc.frequency.linearRampToValueAtTime(550, now + 0.14);
          gain.gain.setValueAtTime(0.04, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
          osc.start(now); osc.stop(now + 0.2);
          break;
        case 'tool':
          osc.type = 'sine';
          osc.frequency.setValueAtTime(600, now);
          osc.frequency.setValueAtTime(800, now + 0.05);
          gain.gain.setValueAtTime(0.03, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
          osc.start(now); osc.stop(now + 0.1);
          break;
        case 'success':
          osc.type = 'sine';
          osc.frequency.setValueAtTime(523, now);
          osc.frequency.setValueAtTime(659, now + 0.08);
          osc.frequency.setValueAtTime(784, now + 0.16);
          gain.gain.setValueAtTime(0.05, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
          osc.start(now); osc.stop(now + 0.28);
          break;
        case 'error':
          osc.frequency.setValueAtTime(300, now);
          osc.frequency.exponentialRampToValueAtTime(200, now + 0.15);
          gain.gain.setValueAtTime(0.05, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
          osc.start(now); osc.stop(now + 0.18);
          break;
      }
      // Don't close the shared context � let the oscillators finish naturally
    } catch { /* AudioContext may be unavailable */ }
  }

  // -- Project Rules (.suny-rules) ----------------------------------------------
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

  // -- Persona per project ------------------------------------------
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

  async function saveProjectAutoExecuteOverride(enabled: boolean | null) {
    if (!activeProject) return;
    const res = await fetch(`/api/projects/${activeProject.id}/auto-execute`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) return;
    setProjects(ps => ps.map(p => p.id === activeProject.id ? { ...p, auto_execute_override: enabled } : p));
    setActiveProject(prev => prev ? { ...prev, auto_execute_override: enabled } : prev);
  }

  async function saveProjectDefaultTier(tier: 'free' | 'fast' | 'pro' | 'auto' | null) {
    if (!activeProject) return;
    const res = await fetch(`/api/projects/${activeProject.id}/default-tier`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier }),
    });
    if (!res.ok) return;
    setProjects(ps => ps.map(p => p.id === activeProject.id ? { ...p, default_tier: tier } : p));
    setActiveProject(prev => prev ? { ...prev, default_tier: tier } : prev);
  }

  // -- Usage stats ----------------------------------------------------------
  interface UsageDay { day: string; input_tokens: number; output_tokens: number; charged_cost: number; }
  interface UsageMode { mode: string; input_tokens: number; output_tokens: number; charged_cost: number; }
  interface UsageProject { project_id: number | null; project_name: string; input_tokens: number; output_tokens: number; charged_cost: number; }
  interface UsageTotals { input_tokens: number; output_tokens: number; charged_cost: number; }
  const [showUsage, setShowUsage] = useState(false);
  const [usageByDay, setUsageByDay] = useState<UsageDay[]>([]);
  const [usageByMode, setUsageByMode] = useState<UsageMode[]>([]);
  const [usageByProject, setUsageByProject] = useState<UsageProject[]>([]);
  const [usageTotals, setUsageTotals] = useState<UsageTotals | null>(null);
  const [usageDays, setUsageDays] = useState(14);

  async function loadUsageStats(days = usageDays) {
    try {
      const res = await fetch(`/api/me/usage?days=${days}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setUsageByDay(data.by_day ?? []);
        setUsageByMode(data.by_mode ?? []);
        setUsageByProject(data.by_project ?? []);
        setUsageTotals(data.totals ?? null);
      }
    } catch {}
  }

  // -- Checkpoints --------------------------------------------------------------
  interface CheckpointEntry { sha: string; message: string; date: string; filesChanged?: number; }
  const [checkpoints, setCheckpoints] = useState<CheckpointEntry[]>([]);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [rollbackConfirm, setRollbackConfirm] = useState<string | null>(null);

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
    setRollbackConfirm(null);
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
        addMessage('system', `? Rolled back to checkpoint \`${sha.slice(0, 7)}\`. Your project files have been restored to that state.`);
      } else {
        const data = await res.json().catch(() => ({}));
        addMessage('system', `?? Rollback failed: ${(data as { error?: string }).error ?? 'Unknown error'}`);
      }
    } finally {
      setRollingBack(null);
    }
  }

  // -- Blueprint Memory Graph ------------------------------------------------
  interface BlueprintEntry {
    id: number;
    category: string;
    summary: string;
    intent: string | null;
    affected_files: string | null;
    created_at: string;
  }
  const [blueprintEntries, setBlueprintEntries] = useState<BlueprintEntry[]>([]);

  async function loadBlueprintEntries(projectId: number) {
    try {
      const res = await fetch(`/api/projects/${projectId}/blueprint`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setBlueprintEntries(data.entries ?? []);
      }
    } catch {}
  }

  function blueprintCategoryLabel(cat: string): string {
    return cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function blueprintCategoryColor(cat: string): string {
    const map: Record<string, string> = {
      bug_fix: 'var(--error)',
      feature_add: 'var(--success)',
      architecture_change: 'var(--accent)',
      refactor: 'var(--warning)',
      design_decision: 'var(--text-muted)',
      dependency_change: '#e8912d',
      config_change: '#888',
      test_strategy: '#6cc',
      user_preference: '#c8a',
      goal_completed: 'var(--success)',
    };
    return map[cat] ?? 'var(--text-muted)';
  }

  // -- End Blueprint Memory Graph ------------------------------------------
  const thinkingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastResponseEvent = useRef(Date.now());
  const requestStartedAtRef = useRef<number | null>(null);
  const thinkingTimedOutRef = useRef(false);
  const statusBagRef = useRef<Record<string, string[]>>({});
  const lastStatusRef = useRef<Record<string, string>>({});

  function pickStatusVariant(group: string, list: string[], fallback: string): string {
    if (!list.length) return fallback;
    const bag = statusBagRef.current[group] ?? [];
    if (bag.length === 0) {
      statusBagRef.current[group] = [...list].sort(() => Math.random() - 0.5);
    }
    let next = statusBagRef.current[group].pop() ?? fallback;
    if (next === lastStatusRef.current[group] && list.length > 1) {
      next = statusBagRef.current[group].pop() ?? list.find(v => v !== lastStatusRef.current[group]) ?? fallback;
    }
    lastStatusRef.current[group] = next;
    return next;
  }

  function clearThinkingTimeout() {
    if (thinkingTimeoutRef.current) {
      clearTimeout(thinkingTimeoutRef.current);
      thinkingTimeoutRef.current = null;
    }
  }

  function resetThinkingTimeout() {
    clearThinkingTimeout();
    lastResponseEvent.current = Date.now();
    if (!requestStartedAtRef.current) requestStartedAtRef.current = Date.now();
    thinkingTimedOutRef.current = false;
    thinkingTimeoutRef.current = setTimeout(() => {
      // No response for 5 min � cancel and notify. (Long installs/builds can take
      // 2-3 minutes silently between narrations, so we use a generous window.)
      setThinking(false);
      setStreamingContent('');
      thinkingTimedOutRef.current = true;
      const durationMs = requestStartedAtRef.current ? Math.max(0, Date.now() - requestStartedAtRef.current) : 300_000;
      addMessage('suny', "SUNy seems to be taking longer than expected. The request timed out safely. Please try again.", {
        timestamp: Date.now(),
        report: {
          durationMs,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          chargedCost: 0,
          humanEstimateMinutes: 0.5,
          humanEstimateCost: 0.29,
          messageCount: 1,
        },
      });
      requestStartedAtRef.current = null;
    }, 300_000);
  }
  const [balance, setBalance] = useState(0);
  const [walletBalance, setWalletBalance] = useState(0);
  const [selectedMode, setSelectedMode] = useState('fast');
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newProjectPathError, setNewProjectPathError] = useState('');

  // -- Create-from-scratch mode ---------------------------------------------
  const [newProjectMode, setNewProjectMode] = useState<'link' | 'scratch'>('link');
  const [scratchDescription, setScratchDescription] = useState('');

  // -- Onboarding -----------------------------------------------------------
  // -- Mobile sidebar toggle ----------------------------------------------
  const [sidebarOpen, setSidebarOpen] = useState(false);
  function toggleSidebar() { setSidebarOpen(s => !s); }
  function closeSidebar() { setSidebarOpen(false); }

  // -- Mobile detection ---------------------------------------------------
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // -- UI theme state (synced with localStorage) -------------------------
  const [uiTheme, setUiTheme] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('suny_ui_theme');
      if (saved === 'matrix' || saved === 'pro' || saved === 'suny') return saved;
      return 'pro';
    } catch { return 'matrix'; }
  });

  // On mobile, default to PRO theme if no explicit theme was ever set
  useEffect(() => {
    if (isMobile) {
      const explicitTheme = localStorage.getItem('suny_ui_theme');
      if (!explicitTheme || explicitTheme === 'matrix') {
        const fromDarkMode = localStorage.getItem('suny_dark_mode');
        if (!fromDarkMode || fromDarkMode !== 'false') {
          // No explicit theme � default to PRO on mobile
          const t = 'pro';
          setUiTheme(t);
          localStorage.setItem('suny_ui_theme', t);
          localStorage.setItem('suny_dark_mode', 'false');
          document.body.classList.remove('theme-matrix', 'theme-pro', 'theme-suny', 'light-mode');
          document.body.classList.add('theme-pro');
        }
      }
    }
  }, [isMobile]);

  // -- Onboarding -----------------------------------------------------------
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => {
    try { return localStorage.getItem('suny_onboarded') !== '1'; } catch { return true; }
  });
  function dismissOnboarding() {
    try { localStorage.setItem('suny_onboarded', '1'); } catch {}
    setShowOnboarding(false);
  }

  // -- File browser ---------------------------------------------------------
  interface FileNode { name: string; path: string; isDir: boolean; children?: FileNode[]; }
  const [fileBrowser, setFileBrowser] = useState<FileNode[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [showFileBrowser, setShowFileBrowser] = useState(false);

  async function loadFileBrowser(projectId: number) {
    try {
      const res = await fetch(`/api/projects/${projectId}/files`, { credentials: 'include' });
      if (res.ok) setFileBrowser(await res.json());
    } catch {}
  }

  // -- Pinned files state & helpers -----------------------------------------
  const [pinnedFiles, setPinnedFiles] = useState<Set<string>>(new Set());

  // -- Vector context index state -------------------------------------------
  const [vectorIndexStats, setVectorIndexStats] = useState<{ chunks: number; files: number; projectId: number } | null>(null);
  const [reindexing, setReindexing] = useState(false);

  async function triggerReindex() {
    if (!activeProject || reindexing) return;
    setReindexing(true);
    try {
      await fetch(`/api/projects/${activeProject.id}/reindex`, { method: 'POST', credentials: 'include' });
    } catch {}
    // Stats will be updated when suny:vector_index_ready arrives
    setTimeout(() => setReindexing(false), 3000);
  }

  useEffect(() => {
    if (activeProject) {
      fetch(`/api/projects/${activeProject.id}/vector-stats`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then((data: { total: number; files: number; indexed_at: string | null } | null) => {
          if (data && data.total > 0) {
            setVectorIndexStats({ chunks: data.total, files: data.files, projectId: activeProject.id });
          } else {
            setVectorIndexStats(null);
          }
        })
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id]);

  async function loadPinnedFiles(projectId: number) {
    try {
      const res = await fetch(`/api/projects/${projectId}/pinned-files`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json() as { files: string[] };
        setPinnedFiles(new Set(data.files));
      }
    } catch {}
  }

  async function togglePinFile(node: FileNode) {
    if (!activeProject) return;
    const isPinned = pinnedFiles.has(node.path);
    if (isPinned) {
      await fetch(`/api/projects/${activeProject.id}/pinned-files/${encodeURIComponent(node.path)}`, {
        method: 'DELETE', credentials: 'include',
      });
      setPinnedFiles(prev => { const next = new Set(prev); next.delete(node.path); return next; });
    } else {
      await fetch(`/api/projects/${activeProject.id}/pinned-files`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_path: node.path }),
      });
      setPinnedFiles(prev => new Set([...prev, node.path]));
    }
  }

  // -- Live server -----------------------------------------------------------
  const [devServerUrl, setDevServerUrl] = useState<string | null>(null);
  const [devServerRunning, setDevServerRunning] = useState(false);
  const [devServerLoading, setDevServerLoading] = useState(false);

  async function startDevServer() {
    if (!activeProject) return;
    setDevServerLoading(true);
    try {
      const res = await fetch(`/api/projects/${activeProject.id}/dev-server/start`, {
        method: 'POST', credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setDevServerUrl(data.url ?? null);
        setDevServerRunning(true);
      }
    } finally { setDevServerLoading(false); }
  }

  async function stopDevServer() {
    if (!activeProject) return;
    setDevServerLoading(true);
    try {
      await fetch(`/api/projects/${activeProject.id}/dev-server/stop`, {
        method: 'POST', credentials: 'include',
      });
      setDevServerRunning(false);
      setDevServerUrl(null);
    } finally { setDevServerLoading(false); }
  }

  // -- Bridge keyboard shortcut help --------------------------------------------
  const [showHelp, setShowHelp] = useState(false);

  function buildDefaultCollapsedSections(): Record<string, boolean> {
    return {
      projects: true,
      archived: true,
      memories: true,
      autoExecute: true,
      freezeBrain: true,
      defaultTier: true,
      rules: true,
      persona: true,
      blueprint: true,
    };
  }

  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(buildDefaultCollapsedSections);
  const [confirmClearMemories, setConfirmClearMemories] = useState(false);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  function stopCurrentResponse() {
    if (!thinking) return;
    wsSend({ type: 'chat:cancel', requestId: '' });
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showUsage) {
        e.preventDefault();
        setShowUsage(false);
        return;
      }

      if (e.key === 'Escape' && thinking) {
        e.preventDefault();
        stopCurrentResponse();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        if (!thinking) clearChat({ requireConfirm: false });
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [showUsage, thinking, clearChat, sendMessage]);

  const lastNarrationRef = useRef('');
  const msgEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputHistoryIndex = useRef(-1);
  const prevThinkingRef = useRef(false);
  const noticeRotationRef = useRef<Record<string, number>>({});
  const sessionId = useRef('s_' + Date.now() + '_' + Math.random().toString(36).slice(2));
  const [sessUsed, setSessUsed] = useState(0);
  const [sessLimit, setSessLimit] = useState<number | null>(null);
  let msgId = useRef(0);
  const [proofRuns, setProofRuns] = useState<ProofRun[]>([]);
  const activeProofIdRef = useRef<number | null>(null);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<number>>(new Set());

  function nextId() { return ++msgId.current; }

  function pickNotice(key: string, variants: string[]): string {
    if (variants.length === 0) return '';
    const index = noticeRotationRef.current[key] ?? 0;
    noticeRotationRef.current[key] = (index + 1) % variants.length;
    return variants[index % variants.length];
  }

  // -- Proof run persistence ------------------------------------------------
  const proofHistoryKey = `suny_proof_runs_${activeProject?.id ?? 'global'}`;

  function saveProofRuns(runs: ProofRun[]) {
    try { localStorage.setItem(proofHistoryKey, JSON.stringify(runs.slice(0, 20))); } catch {}
  }

  function copyProofReportToClipboard(run: ProofRun) {
    const timeStr = new Date(run.startedAt).toLocaleString();
    const durationMs = run.durationMs ?? ((run.finishedAt ?? Date.now()) - run.startedAt);
    const durationSec = (durationMs / 1000).toFixed(1);
    const statusEmoji = run.status === 'completed' ? '?' : run.status === 'failed' ? '?' : '??';
    
    let report = `${statusEmoji} SUNy Proof Report\n`;
    report += `????????????????????????????????????\n`;
    report += `Date: ${timeStr}\n`;
    report += `Duration: ${durationSec}s\n`;
    report += `Status: ${run.status.toUpperCase()}\n\n`;

    if (run.toolCalls.length > 0) {
      report += `Tools Used:\n`;
      run.toolCalls.forEach(tool => {
        report += `  � ${toolLabel(tool)}\n`;
      });
      report += `\n`;
    }

    if (run.checks.length > 0) {
      report += `Checks Performed:\n`;
      run.checks.forEach(check => {
        report += `  ? ${check}\n`;
      });
      report += `\n`;
    }

    if (run.filesChanged) {
      report += `Files Changed: ${run.filesChanged}\n`;
    }
    if (run.steps) {
      report += `Steps: ${run.steps}\n`;
    }

    navigator.clipboard.writeText(report).then(
      () => {
        // Show toast or brief notification
        addMessage('system', '? Proof report copied to clipboard!');
      },
      () => {
        addMessage('system', '?? Could not copy to clipboard');
      }
    );
  }

  function startProofRun() {
    const run: ProofRun = {
      id: Date.now(),
      startedAt: Date.now(),
      status: 'running',
      toolCalls: [],
      checks: [],
    };
    activeProofIdRef.current = run.id;
    setProofRuns(prev => {
      const updated = [run, ...prev].slice(0, 8);
      saveProofRuns(updated);
      return updated;
    });
  }

  function updateActiveProof(updater: (run: ProofRun) => ProofRun) {
    const activeId = activeProofIdRef.current;
    if (!activeId) return;
    setProofRuns(prev => {
      const updated = prev.map(r => (r.id === activeId ? updater(r) : r));
      saveProofRuns(updated);
      return updated;
    });
  }

  function pushToolToProof(toolName: string) {
    updateActiveProof(run =>
      run.toolCalls.includes(toolName)
        ? run
        : { ...run, toolCalls: [...run.toolCalls, toolName] },
    );
  }

  function pushCheckToProof(message: string) {
    updateActiveProof(run => ({ ...run, checks: [...run.checks, message].slice(-12) }));
  }

  function finishActiveProof(status: 'completed' | 'failed') {
    const activeId = activeProofIdRef.current;
    if (!activeId) return;
    setProofRuns(prev => {
      const updated = prev.map(r => (r.id === activeId ? { ...r, status, finishedAt: Date.now() } : r));
      saveProofRuns(updated);
      return updated;
    });
    activeProofIdRef.current = null;
      if (activeProject) {
        loadProjectStateFromServer(activeProject.id).then(remote => {
          if (remote && remote.messages.length > 0) setMessages(remote.messages);
        }).catch(() => {});
      }
  }

  function applyProofSummary(summary: Record<string, unknown>) {
    const activeId = activeProofIdRef.current;
    setProofRuns(prev => {
      if (prev.length === 0) return prev;
      const targetIndex = activeId ? prev.findIndex(r => r.id === activeId) : 0;
      const i = targetIndex >= 0 ? targetIndex : 0;
      const run = prev[i];
      const toolCalls = Array.isArray(summary.toolCalls)
        ? (summary.toolCalls as unknown[]).map(v => String(v))
        : run.toolCalls;
      const nextChecks = [...run.checks];
      if (typeof summary.durationMs === 'number') nextChecks.push(`Duration ${Math.round((summary.durationMs as number) / 1000)}s`);
      if (typeof summary.steps === 'number') nextChecks.push(`Steps ${(summary.steps as number)}`);
      if (typeof summary.filesChanged === 'number') nextChecks.push(`Files changed ${(summary.filesChanged as number)}`);
      const nextRun: ProofRun = {
        ...run,
        toolCalls,
        toolCallCount: typeof summary.toolCallCount === 'number' ? (summary.toolCallCount as number) : run.toolCallCount,
        durationMs: typeof summary.durationMs === 'number' ? (summary.durationMs as number) : run.durationMs,
        filesChanged: typeof summary.filesChanged === 'number' ? (summary.filesChanged as number) : run.filesChanged,
        steps: typeof summary.steps === 'number' ? (summary.steps as number) : run.steps,
        checks: nextChecks.slice(-12),
      };
      const out = [...prev];
      out[i] = nextRun;
      saveProofRuns(out);
      return out;
    });
  }

  function toolLabel(name: string): string {
    const labels: Record<string, string> = {
      file_read: 'Read Files',
      file_edit: 'Edit Files',
      file_write: 'Write Files',
      list_dir: 'List Folders',
      search_code: 'Search Code',
      bash: 'Run Command',
      web_search: 'Web Search',
    };
    return labels[name] ?? name;
  }

  // -- Memory state -------------------------------------------------------------
  const [memories, setMemories] = useState<Memory[]>([]);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [recallingMemory, setRecallingMemory] = useState<Memory | null>(null);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function memoriesKey(projectId: number) { return `suny_memories_${projectId}`; }

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

  async function loadProjectStateFromServer(projectId: number): Promise<{ messages: Message[]; memories: Memory[] } | null> {
    try {
      const res = await fetch(`/api/projects/${projectId}/state`, { credentials: 'include' });
      if (!res.ok) return null;
      const data = await res.json() as { messages?: Message[]; memories?: Memory[] };
      return {
        messages: Array.isArray(data.messages) ? data.messages.slice(-200) : [],
        memories: Array.isArray(data.memories) ? data.memories : [],
      };
    } catch {
      return null;
    }
  }

  async function syncProjectStateToServer(projectId: number, msgs: Message[], mems: Memory[]) {
    try {
      await fetch(`/api/projects/${projectId}/state`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: msgs.slice(-200), memories: mems }),
      });
    } catch {
      // best effort sync
    }
  }

  async function openProject(project: Project) {
    // Save current project's local cache before switching
    if (activeProject && messages.length > 0) {
      saveProjectMessages(activeProject.id, messages);
    }
    setActiveProject(project);
    setCollapsedSections(buildDefaultCollapsedSections());
    setDevServerRunning(false);
    setDevServerUrl(null);
    if (showFileBrowser) loadFileBrowser(project.id);
    loadPinnedFiles(project.id);
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
      content: `?? Recalled memory: "${mem.title}"\n${mem.summary}`,
      id: nextId(),
      timestamp: Date.now(),
    }]);
    setRecallingMemory(null);
  }

  // Load messages when project changes (or when no project is selected)
  useEffect(() => {
    let cancelled = false;
    async function hydrateProjectState(projectId: number) {
      setProjectStateReady(false);

      const localMsgs = loadProjectMessages(projectId);
      const localMems = loadMemories(projectId);

      if (crossDeviceMemoryEnabled) {
        const remote = await loadProjectStateFromServer(projectId);
        if (cancelled) return;
        if (remote) {
          setMessages(remote.messages.length > 0 ? remote.messages : localMsgs);
          setMemories(remote.memories.length > 0 ? remote.memories : localMems);
        } else {
          setMessages(localMsgs);
          setMemories(localMems);
        }
      } else {
        setMessages(localMsgs);
        setMemories(localMems);
      }

      if (!cancelled) setProjectStateReady(true);
    }

    if (activeProject) {
      hydrateProjectState(activeProject.id);
      loadProjectRules(activeProject.id);
      loadCheckpoints(activeProject.id);
      loadBlueprintEntries(activeProject.id);
    } else {
      // Global chat (no project) - load from global storage
      const globalMsgs = loadGlobalChat();
      setMessages(globalMsgs);
      setMemories([]);
      setProjectRules(null);
      setCheckpoints([]);
      setProjectStateReady(true);
    }

    return () => { cancelled = true; };
  }, [activeProject?.id, crossDeviceMemoryEnabled]);

  // -- localStorage persistence --------------------------------------------------
  const globalChatKey = 'suny_chat_global';
  function storageKey(projectId: number) { return `suny_chat_${projectId}`; }

  // -- Multiple global chat tabs ---------------------------------------------
  interface GlobalTab { id: string; name: string; archived?: boolean; }

  const [globalTabs, setGlobalTabs] = useState<GlobalTab[]>(() => {
    try {
      const raw = localStorage.getItem('suny_global_tabs');
      if (raw) return JSON.parse(raw) as GlobalTab[];
    } catch {}
    return [{ id: 'default', name: 'Chat 1' }];
  });

  const [activeTabId, setActiveTabId] = useState<string>(() => {
    try { return localStorage.getItem('suny_active_tab') ?? 'default'; } catch { return 'default'; }
  });

  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renamingTabValue, setRenamingTabValue] = useState('');
  const [deleteConfirmTabId, setDeleteConfirmTabId] = useState<string | null>(null);

  function globalTabKey(tabId: string) { return `suny_chat_global_${tabId}`; }

  function saveGlobalTabs(tabs: GlobalTab[]) {
    try { localStorage.setItem('suny_global_tabs', JSON.stringify(tabs)); } catch {}
  }

  function addGlobalTab() {
    const newId = 'tab_' + Date.now();
    const newName = `Chat ${globalTabs.length + 1}`;
    const newTab = { id: newId, name: newName };
    const updatedTabs = [...globalTabs, newTab];
    setGlobalTabs(updatedTabs);
    saveGlobalTabs(updatedTabs);
    // Save current messages before switching
    try { localStorage.setItem(globalTabKey(activeTabId), JSON.stringify(messages.slice(-200))); } catch {}
    setActiveTabId(newId);
    try { localStorage.setItem('suny_active_tab', newId); } catch {}
    setMessages([]);
  }

  function closeGlobalTab(tabId: string) {
    if (globalTabs.length <= 1) {
      // Just clear the tab instead of closing
      setMessages([]);
      try { localStorage.removeItem(globalTabKey(tabId)); } catch {}
      return;
    }
    const updatedTabs = globalTabs.filter(t => t.id !== tabId);
    setGlobalTabs(updatedTabs);
    saveGlobalTabs(updatedTabs);
    try { localStorage.removeItem(globalTabKey(tabId)); } catch {}
    if (activeTabId === tabId) {
      const newActiveId = updatedTabs[0].id;
      setActiveTabId(newActiveId);
      try { localStorage.setItem('suny_active_tab', newActiveId); } catch {}
      const msgs = (() => { try { const r = localStorage.getItem(globalTabKey(newActiveId)); return r ? (JSON.parse(r) as Message[]).slice(-200).map((m, idx) => normalizeMessage(m, idx)) : []; } catch { return []; } })();
      setMessages(msgs);
    }
  }

  function archiveGlobalTab(tabId: string) {
    const tab = globalTabs.find(t => t.id === tabId);
    if (!tab) return;
    const updatedTabs = globalTabs.map(t => t.id === tabId ? { ...t, archived: true } : t);
    setGlobalTabs(updatedTabs);
    saveGlobalTabs(updatedTabs);
    // Switch to another active tab if we archived the current one
    const activeNonArchived = updatedTabs.find(t => !t.archived);
    if (tabId === activeTabId && activeNonArchived) {
      switchGlobalTab(activeNonArchived.id);
    } else if (tabId === activeTabId) {
      setMessages([]);
      setActiveTabId('');
      try { localStorage.removeItem('suny_active_tab'); } catch {}
    }
  }

  function unarchiveGlobalTab(tabId: string) {
    const updatedTabs = globalTabs.map(t => t.id === tabId ? { ...t, archived: false } : t);
    setGlobalTabs(updatedTabs);
    saveGlobalTabs(updatedTabs);
  }

  function deleteArchivedTab(tabId: string) {
    const updatedTabs = globalTabs.filter(t => t.id !== tabId);
    setGlobalTabs(updatedTabs);
    saveGlobalTabs(updatedTabs);
    try { localStorage.removeItem(globalTabKey(tabId)); } catch {}
    if (activeTabId === tabId) {
      const newActiveId = updatedTabs.length > 0 ? updatedTabs[0].id : 'default';
      setActiveTabId(newActiveId);
      try { localStorage.setItem('suny_active_tab', newActiveId); } catch {}
      const msgs = (() => { try { const r = localStorage.getItem(globalTabKey(newActiveId)); return r ? (JSON.parse(r) as Message[]).slice(-200).map((m, idx) => normalizeMessage(m, idx)) : []; } catch { return []; } })();
      setMessages(msgs);
    }
  }

  function renameGlobalTab(tabId: string, name: string) {
    const nextName = name.trim();
    if (!nextName) return;
    const updatedTabs = globalTabs.map(t => (t.id === tabId ? { ...t, name: nextName } : t));
    setGlobalTabs(updatedTabs);
    saveGlobalTabs(updatedTabs);
  }

  function switchGlobalTab(tabId: string) {
    if (tabId === activeTabId) return;
    // Save current messages
    try { localStorage.setItem(globalTabKey(activeTabId), JSON.stringify(messages.slice(-200))); } catch {}
    setActiveTabId(tabId);
    try { localStorage.setItem('suny_active_tab', tabId); } catch {}
    const msgs = (() => { try { const r = localStorage.getItem(globalTabKey(tabId)); return r ? (JSON.parse(r) as Message[]).slice(-200).map((m, idx) => normalizeMessage(m, idx)) : []; } catch { return []; } })();
    setMessages(msgs);
  }

  function loadProjectMessages(projectId: number): Message[] {
    try {
      const raw = localStorage.getItem(storageKey(projectId));
      if (!raw) return [];
      return (JSON.parse(raw) as Message[]).slice(-200).map((m, idx) => normalizeMessage(m, idx));
    } catch { return []; }
  }

  function loadGlobalChat(): Message[] {
    // Try the tab-based key first, fall back to legacy key for migration
    try {
      const tabKey = globalTabKey(activeTabId);
      const raw = localStorage.getItem(tabKey);
      if (raw) return (JSON.parse(raw) as Message[]).slice(-200).map((m, idx) => normalizeMessage(m, idx));
      // Migrate from legacy key on first load for default tab
      if (activeTabId === 'default') {
        const legacyRaw = localStorage.getItem(globalChatKey);
        if (legacyRaw) {
          const msgs = (JSON.parse(legacyRaw) as Message[]).slice(-200).map((m, idx) => normalizeMessage(m, idx));
          try { localStorage.setItem(tabKey, JSON.stringify(msgs)); } catch {}
          return msgs;
        }
      }
      return [];
    } catch { return []; }
  }

  function saveProjectMessages(projectId: number, msgs: Message[]) {
    try { localStorage.setItem(storageKey(projectId), JSON.stringify(msgs.slice(-200))); } catch {}
  }

  function saveGlobalChat(msgs: Message[]) {
    try { localStorage.setItem(globalTabKey(activeTabId), JSON.stringify(msgs.slice(-200))); } catch {}
  }

  useEffect(() => {
    if (!projectStateReady) return;
    
    if (activeProject) {
      saveProjectMessages(activeProject.id, messages);
      saveMemories(activeProject.id, memories);

      if (!crossDeviceMemoryEnabled) return;
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      syncTimerRef.current = setTimeout(() => {
        syncProjectStateToServer(activeProject.id, messages, memories);
      }, 450);
    } else {
      // Global chat - save to global storage
      saveGlobalChat(messages);
    }
  }, [messages, memories, activeProject?.id, projectStateReady, crossDeviceMemoryEnabled]);

  // Register service worker once on mount
  useEffect(() => { registerServiceWorker(); }, []);

  const { send: wsSend, isConnected, pendingCount, clearPending } = useWebSocket({
    onMessage: (msg) => {
      if (msg.event === 'suny:forecast_loading') {
        setForecastLoading(true);
        setForecastEstimate(null);
        return;
      } else if (msg.event === 'suny:pre_run_estimate') {
        setForecastLoading(false);
        setForecastEstimate({
          lowCredits: msg.lowCredits as number,
          highCredits: msg.highCredits as number,
          historicalSamples: msg.historicalSamples as number,
          estimatedSteps: msg.estimatedSteps as number,
          confidence: msg.confidence as string,
          basedOn: msg.basedOn as string,
          currentBalance: msg.currentBalance as number,
          mode: msg.mode as string,
        });
        return;
      } else if (msg.event === 'suny:health_score') {
        window.dispatchEvent(new CustomEvent('suny:health_score', {
          detail: { score: msg.score, delta: msg.delta, projectId: msg.projectId },
        }));
        return;
      } else if (msg.event === 'suny:budget_warning') {
        setBudgetWarning({ spent: msg.spent as number, cap: msg.cap as number, pct: msg.pct as number });
        // Auto-dismiss warning after 8s
        setTimeout(() => setBudgetWarning(null), 8000);
        return;
      } else if (msg.event === 'suny:budget_gate') {
        setBudgetGateOpen({ spent: msg.spent as number, cap: msg.cap as number });
        return;
      } else if (msg.event === 'suny:budget_exceeded') {
        addMessage('system', `⚠️ **Budget cap reached** — ${msg.message as string}`);
        return;
      } else if (msg.event === 'suny:checkpoint') {
        setCheckpoint({ label: msg.label as string, details: msg.details as string });
        return;
      } else if (msg.event === 'suny:narration') {
        lastNarrationRef.current = msg.message as string;
        if (thinking) {
          // Tool narrations are signs of life � keep the watchdog alive.
          resetThinkingTimeout();
          // New iteration starting � wipe the previous iteration's streamed text so
          // intermediate tool-call narration doesn't accumulate in the display bubble.
          setStreamingContent('');
          streamingContentRef.current = '';
          // During active processing: show as status in the thinking indicator, not a chat bubble
          setThinkingStatus(msg.message as string);
        } else if (thinkingTimedOutRef.current) {
          // Late narration arriving after a timeout-abort: ignore (would otherwise
          // spam the chat with separate "Running command..." bubbles for every tool call).
        } else {
          // Not thinking (error messages, cancel confirmations): add as permanent chat bubble
          clearThinkingTimeout();
          addMessage('suny', msg.message as string);
        }
      } else if (msg.event === 'suny:thinking') {
        setThinking(true);
        setThinkingStatus('');
        setStreamingContent('');
        if (!activeProofIdRef.current) startProofRun();
        resetThinkingTimeout();
      } else if (msg.event === 'suny:vector_index_ready') {
        const data = msg as unknown as { projectId: number; chunks: number; files: number };
        setVectorIndexStats({ chunks: data.chunks, files: data.files, projectId: data.projectId });
      } else if (msg.event === 'suny:preparation_step') {
        setThinkingStatus(pickStatusVariant('prep', [
          'Getting everything ready�',
          'Setting up the best approach�',
          'Preparing your answer now�',
          'Organizing the next steps�',
          'Lining up what needs to happen�',
          'Getting this ready for you�',
          'Starting with the essentials�',
          'Putting the plan in motion�',
          'Collecting what I need first�',
          'Preparing a clean run�',
        ], 'Preparing your answer�'));
      } else if (msg.event === 'suny:done') {
        clearThinkingTimeout();
        setThinking(false);
        setThinkingStatus('');
        finishActiveProof('completed');
        addMessage('suny', msg.message as string);
      } else if (msg.event === 'suny:stage') {
        const stage = msg.stage as string;
        const label = msg.label as string || '';
        // Show stage transitions in the thinking status for active processing
        if (thinking) {
          setThinkingStatus(`[${stage}] ${label}`);
        }
      } else if (msg.event === 'suny:suggest_tier_upgrade') {
        const cur = selectedMode || String(msg.currentMode ?? 'auto');
        const routed = String(msg.routedMode ?? msg.currentMode ?? cur);
        const sug = String(msg.suggestedMode ?? 'pro');
        const reason = String(msg.reason ?? 'unknown');
        const reasonText = reason === 'step_exhaustion'
          ? 'This run stopped before finishing the task.'
          : reason === 'retries_exhausted'
          ? 'I could not produce a useful response after multiple retries.'
          : reason === 'all_providers_failed'
          ? 'All configured models for this tier failed.'
          : 'This task seems harder than the current tier can handle.';
        const upgradeHint = pickNotice(`upgrade:${reason}:${cur}:${sug}`, [
          `Try the **${sug}** mode in the top bar and send the message again.`,
          `Move up to **${sug}** for a stronger model, then resend the request.`,
          `Use **${sug}** mode for another pass with deeper reasoning.`,
        ]);
        addMessage(
          'suny',
          `?? **${reasonText}**\n\n${cur === 'auto' && routed !== 'auto'
            ? `You're using **auto** mode, and this run was routed to **${routed}**. `
            : `You're on **${cur}** mode. `}` +
          `Switching to **${sug}** mode gives me a stronger model that handles multi-step coding, ` +
          `longer plans, and trickier edits. ${upgradeHint}`,
        );
        playSound('error');
      } else if (msg.event === 'suny:out_of_balance') {
        const reason = String(msg.reason ?? 'no_credits');
        const message = typeof msg.message === 'string' && msg.message
          ? msg.message
          : 'Your bot wallet balance is empty. I can still chat in free mode, but coding actions need credits.';
        const title = reason === 'daily_limit' ? '? Daily limit reached' : '?? Out of credits';
        addMessage('suny', `${title}\n\n${message}\n\n${pickNotice(`credits:${reason}`, [
          'Use the Top up button below the chat input, or keep chatting in free mode.',
          'You can top up from the button under the chat box, or continue in free mode.',
          'Tap Top up below if you want more actions, otherwise stay in free chat.',
        ])}`);
        
        if (balance > 0 && walletBalance <= 0) {
          onOpenSettings('wallet', 'Top up your Bot Wallet by transferring from your Main Balance.');
        } else {
          setShowTopUp(true);
        }
        playSound('error');
      } else if (msg.event === 'suny:topup_resolved') {
        const status = String(msg.status ?? 'approved');
        const amt = Number(msg.amount ?? 0);
        const notes = typeof msg.adminNotes === 'string' ? msg.adminNotes : '';
        if (status === 'approved') {
          addMessage('suny', `? **Top-up approved!** $${amt.toFixed(2)} added to your wallet.${notes ? `\n\n_Note from admin: ${notes}_` : ''}\n\n_${pickNotice('topup-approved', [
            'Balance updated, so you can keep going.',
            'You are funded again and ready for the next task.',
            'The wallet is topped up and SUNy can continue.',
          ])}_`);
          playSound('success');
        } else {
          addMessage('suny', `? **Top-up rejected.**${notes ? `\n\n_Reason: ${notes}_` : ' Contact the admin for details.'}\n\n_${pickNotice('topup-rejected', [
            'If you want to keep working, you can stay in free chat for now.',
            'Try again later or ask the admin for help with the balance.',
            'The request did not go through this time, but you can retry later.',
          ])}_`);
          playSound('error');
        }
      } else if (msg.event === 'suny:tool_call') {
        const toolName = String(msg.tool ?? 'unknown_tool');
        pushToolToProof(toolName);
        playSound('tool');
      } else if (msg.event === 'suny:stream_start') {
        setThinking(true);
        setThinkingStatus('');
        setStreamingContent('');
        requestStartedAtRef.current = Date.now();
        if (!activeProofIdRef.current) startProofRun();
        resetThinkingTimeout();
      } else if (msg.event === 'suny:stream_chunk') {
        lastResponseEvent.current = Date.now();
        setStreamingContent(prev => {
          const next = (prev === 'SUNy is thinking...' || prev === '') ? (msg.chunk as string) : prev + (msg.chunk as string);
          streamingContentRef.current = next;
          return next;
        });
      } else if (msg.event === 'suny:stream_end') {
        clearThinkingTimeout();
        setThinking(false);
        setThinkingStatus('');
        const requestDurationMs = requestStartedAtRef.current ? Math.max(0, Date.now() - requestStartedAtRef.current) : 0;
        requestStartedAtRef.current = null;
        if (msg.routing_reason && typeof msg.routing_reason === 'string') {
          setRoutingReason(msg.routing_reason);
        }
        if (msg.resolved_mode && typeof msg.resolved_mode === 'string') {
          setResolvedMode(msg.resolved_mode);
        }
        if (msg.proof_summary && typeof msg.proof_summary === 'object') {
          applyProofSummary(msg.proof_summary as Record<string, unknown>);
        }
        finishActiveProof('completed');
        playSound('receive');
        // Prefer server-provided final content; fall back to what was streamed live, then to last narration
        const finalContent = (msg.content as string)?.trim() || streamingContentRef.current || lastNarrationRef.current;
        if (finalContent) {
          const rawReport = msg.turn_report as Record<string, unknown> | undefined;
          const report = rawReport && typeof rawReport.durationMs === 'number'
            ? {
              durationMs: rawReport.durationMs as number,
              totalTokens: typeof rawReport.totalTokens === 'number'
                ? rawReport.totalTokens as number
                : (typeof rawReport.inputTokens === 'number' ? rawReport.inputTokens as number : 0) + (typeof rawReport.outputTokens === 'number' ? rawReport.outputTokens as number : 0) + (typeof rawReport.cacheWriteTokens === 'number' ? rawReport.cacheWriteTokens as number : 0) + (typeof rawReport.cacheReadTokens === 'number' ? rawReport.cacheReadTokens as number : 0),
              inputTokens: typeof rawReport.inputTokens === 'number' ? rawReport.inputTokens as number : 0,
              outputTokens: typeof rawReport.outputTokens === 'number' ? rawReport.outputTokens as number : 0,
              cacheWriteTokens: typeof rawReport.cacheWriteTokens === 'number' ? rawReport.cacheWriteTokens as number : 0,
              cacheReadTokens: typeof rawReport.cacheReadTokens === 'number' ? rawReport.cacheReadTokens as number : 0,
              chargedCost: typeof rawReport.chargedCost === 'number' ? rawReport.chargedCost as number : 0,
                rawCost: typeof rawReport.rawCost === 'number' ? rawReport.rawCost as number : 0,
              humanEstimateMinutes: typeof rawReport.humanEstimateMinutes === 'number' ? rawReport.humanEstimateMinutes as number : 0,
              humanEstimateCost: typeof rawReport.humanEstimateCost === 'number' ? rawReport.humanEstimateCost as number : 0,
              messageCount: 1,
            } satisfies ReportMetrics
            : {
              durationMs: requestDurationMs,
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
              chargedCost: 0,
              humanEstimateMinutes: 0.5,
              humanEstimateCost: 0.29,
              messageCount: 1,
            };
          addMessage('suny', finalContent, { timestamp: Date.now(), report });
        } else {
          addMessage('suny', "I finished processing but didn't receive a final reply text. Please send that again and I'll answer right away.", {
            timestamp: Date.now(),
            report: {
              durationMs: requestDurationMs,
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
              chargedCost: 0,
              humanEstimateMinutes: 0.5,
              humanEstimateCost: 0.29,
              messageCount: 1,
            },
          });
        }
        lastNarrationRef.current = '';
        setStreamingContent('');
        streamingContentRef.current = '';
        if (msg.sess_used !== undefined) setSessUsed(msg.sess_used as number);
        if (msg.sess_limit !== undefined) setSessLimit(msg.sess_limit as number | null);
        // Refresh checkpoints and blueprint after agent turn
        if (activeProject) {
          loadCheckpoints(activeProject.id);
          loadBlueprintEntries(activeProject.id);
        }
        loadProjectSpend();

        // Browser push receipt — only when notify enabled AND document is hidden
        if (notifyOnComplete && document.hidden) {
          const tr = msg.turn_report as Record<string, unknown> | undefined;
          const filesChanged = (tr && typeof (msg.proof_summary as any)?.filesChanged === 'number')
            ? (msg.proof_summary as any).filesChanged as number
            : 0;
          const ps = msg.proof_summary as Record<string, unknown> | undefined;
          sendRunReceipt({
            taskLabel: lastUserMessageRef.current || 'Task',
            filesChanged,
            testsPassed: ps && typeof ps.testPassed === 'boolean' && ps.testRuns ? (ps.testPassed ? (ps.testRuns as number) : 0) : undefined,
            testsFailed: ps && typeof ps.testFailuresFound === 'number' ? (ps.testFailuresFound as number) : undefined,
            creditsUsed: tr && typeof tr.chargedCost === 'number' ? (tr.chargedCost as number) : 0,
            durationMs: tr && typeof tr.durationMs === 'number' ? (tr.durationMs as number) : 0,
            success: true,
          });
        }
      } else if (msg.event === 'suny:lint_running') {
        pushCheckToProof('Lint check started');
        setThinkingStatus(pickStatusVariant('lint_running', [
          'Doing a quick quality check�',
          'Scanning for small issues�',
          'Checking for fixable problems�',
          'Running a code quality pass�',
          'Looking for anything to clean up�',
          'Reviewing for warnings and errors�',
          'Making sure everything is neat�',
        ], 'Checking for issues�'));
      } else if (msg.event === 'suny:lint_errors') {
        pushCheckToProof(`Lint found ${msg.errorCount as number} error(s) on pass ${msg.attempt as number}`);
        const lintErrorStatus = pickStatusVariant('lint_errors', [
          'I found {count} issue(s). Fixing them now (round {attempt})�',
          '{count} issue(s) spotted. Cleaning this up (round {attempt})�',
          'Found {count} thing(s) to fix. Working on it (round {attempt})�',
          'A few issues showed up ({count}). Repairing now (round {attempt})�',
        ], 'I found {count} issue(s). Fixing now (round {attempt})�');
        setThinkingStatus(lintErrorStatus
          .replace('{count}', String(msg.errorCount as number))
          .replace('{attempt}', String(msg.attempt as number)));
      } else if (msg.event === 'suny:lint_passed') {
        pushCheckToProof('Lint passed');
        setThinkingStatus(pickStatusVariant('lint_passed', [
          'Great news � quality checks passed ?',
          'Looks clean now ?',
          'All quality checks are clear ?',
          'Nice � no remaining quality issues ?',
        ], 'Quality checks passed ?'));
        playSound('success');
      } else if (msg.event === 'suny:test_running') {
        pushCheckToProof(
          (msg.attempt as number) === 0
            ? 'Tests started'
            : `Tests re-run attempt ${(msg.attempt as number) + 1}`,
        );
        setThinkingStatus((msg.attempt as number) === 0
          ? pickStatusVariant('test_running', [
              'Running checks to confirm everything works�',
              'Testing the latest changes�',
              'Validating behavior now�',
              'Checking that everything still works�',
              'Running reliability checks�',
            ], 'Running checks�')
          : pickStatusVariant('test_rerun', [
              `Trying the checks again (round ${(msg.attempt as number) + 1})�`,
              `Re-checking after fixes (round ${(msg.attempt as number) + 1})�`,
              `Running another validation pass (round ${(msg.attempt as number) + 1})�`,
            ], `Running checks again (round ${(msg.attempt as number) + 1})�`));
      } else if (msg.event === 'suny:test_errors') {
        pushCheckToProof(`Tests found ${msg.failCount as number} failure(s) on attempt ${msg.attempt as number}`);
        const testErrorStatus = pickStatusVariant('test_errors', [
          '{count} check(s) failed. Fixing now (round {attempt})�',
          'I found {count} failing check(s). Repairing them (round {attempt})�',
          '{count} issue(s) remain in validation. Working through them (round {attempt})�',
        ], '{count} check(s) failed. Fixing now (round {attempt})�');
        setThinkingStatus(testErrorStatus
          .replace('{count}', String(msg.failCount as number))
          .replace('{attempt}', String(msg.attempt as number)));
      } else if (msg.event === 'suny:test_passed') {
        pushCheckToProof('Tests passed');
        setThinkingStatus((msg.attempt as number) === 0
          ? pickStatusVariant('test_passed', [
              'Everything checked out ?',
              'All validations passed ?',
              'Looks good � checks are green ?',
              'Done � all checks passed ?',
            ], 'All checks passed ?')
          : pickStatusVariant('test_passed_retry', [
              `All checks are passing now ? (fixed in ${msg.attempt as number} round(s))`,
              `Great, it passes after ${msg.attempt as number} fix round(s) ?`,
              `Resolved and verified ? (${msg.attempt as number} correction round(s))`,
            ], `All checks are passing now ? (${msg.attempt as number} rounds)`));
      } else if (msg.event === 'suny:test_gave_up') {
        pushCheckToProof('Tests still failing after retries');
        finishActiveProof('failed');
        setThinkingStatus('');
        addMessage('system', `?? Tests still failing after multiple attempts. SUNy couldn't automatically fix all test failures.\n\n?? **Tip:** Try asking SUNy to explain the failing tests, or check if your test setup requires any environment variables or mocked dependencies.`);
      } else if (msg.event === 'suny:lint_gave_up') {
        pushCheckToProof(`Lint still failing after retries (${msg.errorCount as number} error(s))`);
        finishActiveProof('failed');
        addMessage('system', `?? ${msg.errorCount} lint error(s) remain after ${3} fix attempts using \`${msg.command}\`.\n\n?? **Tip:** You can ask SUNy: *"Fix the remaining lint errors"* or run \`${msg.command}\` in your terminal to see the full output.`);
      } else if (msg.event === 'suny:balance') {
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
      // Reset stale state on reconnect � avoids forever-spinning thinking indicator
      clearThinkingTimeout();
      setThinking(false);
      setThinkingStatus('');
      setStreamingContent('');
      streamingContentRef.current = '';
      activeProofIdRef.current = null;
      if (activeProject) {
        loadProjectStateFromServer(activeProject.id).then(remote => {
          if (remote && remote.messages.length > 0) setMessages(remote.messages);
        }).catch(() => {});
      }
    },
    onDisconnect: () => { setBridgeConnected(false); },
  });

  useEffect(() => { loadUserData(); loadProjects(); return () => clearThinkingTimeout(); }, []);

  // Bridge status resilience: poll /api/bridge/status every 30s as a fallback
  // in case a WS bridge:connected/disconnected event is missed (e.g. tab was
  // backgrounded). Cheap (single bool fetch) and keeps the badge accurate.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/bridge/status', { credentials: 'include' });
        if (!cancelled && res.ok) {
          const data = await res.json();
          if (typeof data.connected === 'boolean') setBridgeConnected(data.connected);
        }
      } catch { /* ignore transient network errors */ }
    };
    const id = setInterval(tick, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  useEffect(() => { msgEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, thinking]);
  // Focus input when thinking state changes (message sent or response received)
  useEffect(() => {
    if (prevThinkingRef.current !== thinking) {
      prevThinkingRef.current = thinking;
      inputRef.current?.focus();
    }
  }, [thinking]);
  useEffect(() => {
    const lines = [
      'Pick any project and I will jump in immediately.',
      'Choose a project from the sidebar and we can build right away.',
      'Ready when you are. Open a project and let us start shipping.',
      'Select a project and tell me the goal. I will handle the heavy lifting.',
      'Open one of your projects and I can start coding end-to-end.',
    ];
    const pick = () => setGlobalIntroLine(lines[Math.floor(Math.random() * lines.length)]);
    pick();
    const t = setInterval(pick, 12000);
    return () => clearInterval(t);
  }, []);

  async function loadUserData() {
    const res = await fetch('/api/me', { credentials: 'include' });
    if (res.ok) {
      const data: UserData = await res.json();
      setUserData(data);
      setBalance(data.balance);
      setWalletBalance(data.wallet_balance);
      setSelectedMode(data.selected_mode);
      setBridgeConnected(data.bridge_connected);
      setBridgePreviouslyConnected(Boolean(data.bridge_previously_connected));
      setCrossDeviceMemoryEnabled(Boolean(data.cross_device_memory_enabled));
      setShowTechnicalDetails(Boolean(data.chat_show_technical_details));
      setGlobalAutoApprove(data.auto_approve !== false);
      if (data.max_tokens_per_session != null) setSessLimit(data.max_tokens_per_session);
    }
  }

  function getEffectiveAutoExecute(projectId?: number): boolean {
    if (!projectId) return globalAutoApprove;
    const proj = projects.find(p => p.id === projectId);
    if (!proj || proj.auto_execute_override == null) return globalAutoApprove;
    return proj.auto_execute_override;
  }

  async function loadProjects() {
    const res = await fetch('/api/projects', { credentials: 'include' });
    if (res.ok) setProjects(await res.json());
    await loadProjectSpend();
  }

  async function loadProjectSpend() {
    try {
      const res = await fetch('/api/projects/spend', { credentials: 'include' });
      if (!res.ok) return;
      const rows = await res.json() as ProjectSpend[];
      const next: Record<number, ProjectSpend> = {};
      for (const row of rows) next[row.project_id] = row;
      setProjectSpend(next);
    } catch {
      // best effort only
    }
  }

  function formatTokenCount(tokens: number): string {
    if (!isFinite(tokens) || tokens <= 0) return '0';
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
    return `${Math.round(tokens)}`;
  }

  function formatSpend(cost: number): string {
    if (!isFinite(cost) || cost <= 0) return '$0.00';
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(cost < 1 ? 3 : 2)}`;
  }

  function addMessage(type: 'user' | 'suny' | 'system', content: string, meta?: { timestamp?: number; report?: ReportMetrics }) {
    setMessages(ms => [...ms, {
      type,
      content,
      id: nextId(),
      timestamp: meta?.timestamp ?? Date.now(),
      report: meta?.report,
    }]);
  }

  function summarizeProjectMessages(projectId: number): ReportMetrics {
    const sourceMessages = activeProject?.id === projectId ? messages : loadProjectMessages(projectId);
    const reportMessages = sourceMessages.filter(m => m.type === 'suny' && m.report);
    const fallbackSpend = projectSpend[projectId];

    if (reportMessages.length === 0) {
      return {
        durationMs: 0,
        totalTokens: fallbackSpend?.total_tokens ?? 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        chargedCost: fallbackSpend?.total_cost ?? 0,
          rawCost: 0,
        humanEstimateMinutes: 0,
        humanEstimateCost: 0,
        messageCount: 0,
      };
    }

    const totals = reportMessages.reduce((acc, msg) => {
      const report = msg.report as ReportMetrics;
      acc.durationMs += report.durationMs;
      acc.totalTokens += report.totalTokens;
      acc.inputTokens += report.inputTokens;
      acc.outputTokens += report.outputTokens;
      acc.cacheWriteTokens += report.cacheWriteTokens;
      acc.cacheReadTokens += report.cacheReadTokens;
      acc.chargedCost += report.chargedCost;
        acc.rawCost = (acc.rawCost || 0) + (report.rawCost || 0);
      acc.humanEstimateMinutes += report.humanEstimateMinutes;
      acc.humanEstimateCost += report.humanEstimateCost;
      return acc;
    }, {
      durationMs: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      chargedCost: 0,
      humanEstimateMinutes: 0,
      humanEstimateCost: 0,
    });

    return {
      ...totals,
      messageCount: reportMessages.length,
    };
  }

  async function sendPreparedMessage(text: string, opts?: { forceWriteMode?: boolean; projectIdOverride?: number; overrideThinkingCheck?: boolean }) {
    const cleaned = text.trim();
    if (!cleaned) return;

    const looksLikeExecutionTask = /(create|scaffold|build|generate|edit|fix|implement|run|install|start|delete|rename|refactor|file|folder|project)/i.test(cleaned);
    let effectiveTalkMode = opts?.forceWriteMode ? false : talkMode;
    let effectiveMode = selectedMode;
    const effectiveProjectId = opts?.projectIdOverride ?? activeProject?.id;
    const effectiveAutoExecute = getEffectiveAutoExecute(effectiveProjectId);
    const noCredits = balance <= 0 && walletBalance <= 0;

    if (talkMode && opts?.forceWriteMode) {
      addMessage('system', 'Switched this action to Write Mode automatically so SUNy can execute your scaffold request immediately.');
    } else if (effectiveTalkMode && looksLikeExecutionTask) {
      addMessage('system', 'Talk Mode is ON, so I will explain steps but not execute file or shell actions. Switch to Write Mode (pencil icon) to let SUNy perform the task.');
    }

    if (noCredits) {
      effectiveMode = 'free';
      effectiveTalkMode = true;
      if (looksLikeExecutionTask) {
        addMessage('system', 'Credits are empty, so SUNy is staying in free talk mode. It can explain the steps, but it will not run file or shell actions until you top up.');
      }
    }

    if (!effectiveAutoExecute && !noCredits) {
      effectiveTalkMode = true;
      if (looksLikeExecutionTask) {
        addMessage('system', 'Auto-Execute is OFF for this project, so SUNy will explain steps without running file or shell actions. Turn Auto-Execute ON in this project to allow full execution.');
      }
    }

    if (effectiveProjectId && !bridgeConnected && looksLikeExecutionTask) {
      addMessage('system', 'Bridge is offline, so SUNy cannot create files or run commands right now. Reconnect the bridge to execute this task end-to-end.');
    }

    setInput('');
    inputHistoryIndex.current = -1;
    addMessage('user', cleaned);
    setThinking(true);
    requestStartedAtRef.current = Date.now();
    lastUserMessageRef.current = cleaned.slice(0, 60) + (cleaned.length > 60 ? '…' : '');
    playSound('send');

    const payload: Record<string, unknown> = {
      type: 'chat:message',
      message: cleaned,
      mode: effectiveMode,
      sessionId: sessionId.current,
      talkMode: effectiveTalkMode,
      showTechnicalDetails,
      history: messages
        .filter(m => m.type === 'user' || m.type === 'suny')
        .map(m => ({ role: m.type === 'user' ? 'user' : 'assistant', content: m.content })),
    };

    if (imagePreview) payload.imageData = imagePreview;

    if (effectiveProjectId) payload.projectId = effectiveProjectId;
    else if (projects.length > 0) payload.projectNames = projects.map(p => p.name);

    if (thinking && !opts?.overrideThinkingCheck) {
      const behavior = userData?.task_interruption_behavior || 'interrupt';
      if (behavior === 'queue') {
        setQueuedPrompt({ text: cleaned, payload, status: 'queued', timeLeft: 0 });
      } else {
        setQueuedPrompt({ text: cleaned, payload, status: 'interrupting', timeLeft: 4 });
      }
      return;
    }

    wsSend(payload);
    // Clear image preview after sending
    setImagePreview(null);
  }

  async function sendMessage() {
    await sendPreparedMessage(input);
  }

  async function changeMode(mode: string) {
    if (noBalance && mode !== 'free') return;
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
    const isAbsolute = /^[A-Za-z]:[\\//]/.test(trimmedPath) || trimmedPath.startsWith('/') || /^\\\\/.test(trimmedPath);
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

  async function pickFolderPath(onPicked: (path: string) => void) {
    const promptForPath = () => {
      const typed = window.prompt('Enter the full folder path for this project:', newProjectPath.trim() || '');
      const cleaned = typed?.trim() || '';
      if (!cleaned) return;
      onPicked(cleaned);
      setNewProjectPathError('');
    };

    try {
      const res = await fetch('/api/pick-folder', { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        promptForPath();
        return;
      }
      const data = await res.json() as { path?: string };
      if (!data.path) {
        promptForPath();
        return;
      }
      onPicked(data.path);
      setNewProjectPathError('');
    } catch {
      promptForPath();
    }
  }

  async function deleteProject(id: number) {
    const project = projects.find(p => p.id === id);
    const label = project?.name ? `"${project.name}"` : 'this project';
    const ok = window.confirm(`Delete ${label}? This cannot be undone.`);
    if (!ok) return;

    const res = await fetch(`/api/projects/${id}`, { method: 'DELETE', credentials: 'include' });
    if (!res.ok) {
      let message = 'Failed to delete project.';
      try {
        const data = await res.json() as { error?: string };
        if (data?.error) message = data.error;
      } catch {}
      window.alert(message);
      return;
    }

    setProjects(ps => ps.filter(p => p.id !== id));
    setProjectSpend(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (activeProject?.id === id) setActiveProject(null);
  }

  function clearChat(opts?: { requireConfirm?: boolean }) {
    const requireConfirm = opts?.requireConfirm !== false;
    if (requireConfirm && messages.length > 0) {
      const ok = window.confirm('Clear this chat? This will remove the current conversation from the chat view.');
      if (!ok) return;
    }
    // Save conversation as a memory before clearing
    if (activeProject && messages.length > 0) {
      const userMsgs = messages.filter(m => m.type === 'user').map(m => m.content);
      const lastUserMsg = userMsgs[userMsgs.length - 1] || '';
      const title = lastUserMsg.length > 60 ? lastUserMsg.slice(0, 57) + '�' : (lastUserMsg || 'Chat session');
      // Build a compact summary: last user message + count of messages
      const summary = `${messages.length} messages � Last asked: "${lastUserMsg.slice(0, 120)}"`;
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
    setProofRuns([]);
    setExpandedRunIds(new Set());
    activeProofIdRef.current = null;
      if (activeProject) {
        loadProjectStateFromServer(activeProject.id).then(remote => {
          if (remote && remote.messages.length > 0) setMessages(remote.messages);
        }).catch(() => {});
      }
    if (activeProject) {
      localStorage.removeItem(storageKey(activeProject.id));
    } else {
      try {
        localStorage.removeItem(globalTabKey(activeTabId));
        localStorage.removeItem(globalChatKey);
      } catch {}
    }
    localStorage.removeItem(proofHistoryKey);
  }

  // -- Delete single message from context --------------------------------
  function deleteMessage(id: number) {
    setMessages(prev => prev.filter(m => m.id !== id));
  }

  // Regenerate: drop this user message and everything after, then re-send its content.
  async function regenerateUserMessage(id: number) {
    if (thinking) return;
    const idx = messages.findIndex(m => m.id === id);
    if (idx < 0) return;
    const target = messages[idx];
    if (target.type !== 'user') return;
    setMessages(prev => prev.slice(0, idx));
    await sendPreparedMessage(target.content);
  }

  // Edit: prefill the composer with this user message's content, drop it and everything after.
  // User can then tweak and press Send.
  function editUserMessage(id: number) {
    if (thinking) return;
    const idx = messages.findIndex(m => m.id === id);
    if (idx < 0) return;
    const target = messages[idx];
    if (target.type !== 'user') return;
    setMessages(prev => prev.slice(0, idx));
    setInput(target.content);
  }

  // -- Memory Snapshots (unified: messages + memory + tier + skills) -------
  interface MemorySnapshot {
    id: string;
    label: string;
    kind: 'manual' | 'auto';
    savedAt: number;
    message_count: number;
    has_memory: boolean;
    tier: string | null;
    messages: Message[];
  }

  async function loadSnapshots(): Promise<MemorySnapshot[]> {
    try {
      const url = activeProject
        ? `/api/snapshots?project_id=${activeProject.id}`
        : '/api/snapshots';
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return [];
      const data = await res.json() as MemorySnapshot[];
      setSnapshotList(data);
      return data;
    } catch { return []; }
  }

  async function saveSnapshot() {
    if (messages.length === 0) return;
    const label = (() => {
      const last = messages.filter(m => m.type === 'user').slice(-1)[0];
      const raw = last?.content ?? '';
      return raw.length > 50 ? raw.slice(0, 47) + '�' : (raw || 'Snapshot');
    })();
    try {
      const res = await fetch('/api/snapshots', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: activeProject?.id ?? null,
          label,
          messages: [...messages],
          capture_memory: true,
        }),
      });
      if (!res.ok) return;
      await loadSnapshots();
      addMessage('system', `?? Snapshot saved as **"${label}"** (conversation + memory). Restore it any time from the Snapshots menu.`);
      setShowSnapshots(true);
    } catch {}
  }

  async function restoreSnapshot(snap: MemorySnapshot, opts: { conversation: boolean; memory: boolean; code: boolean }) {
    try {
      const res = await fetch(`/api/snapshots/${encodeURIComponent(snap.id)}/restore`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restore_conversation: opts.conversation,
          restore_memory: opts.memory,
          restore_code: opts.code,
        }),
      });
      if (!res.ok) return;
      const data = await res.json() as { messages?: Message[]; memory_restored?: boolean; code_checkpoint_id?: number | null };
      if (opts.conversation && data.messages) setMessages(data.messages);
      setShowSnapshots(false);
      setRestoreTarget(null);
      const parts: string[] = [];
      if (opts.conversation) parts.push('conversation');
      if (opts.memory && data.memory_restored) parts.push('memory');
      if (opts.code && data.code_checkpoint_id) parts.push(`code (checkpoint #${data.code_checkpoint_id})`);
      addMessage('system', `✅ Restored **"${snap.label}"** � ${parts.join(' + ') || 'nothing selected'}.`);
    } catch {}
  }

  async function deleteSnapshot(id: string) {
    try {
      await fetch(`/api/snapshots/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      setSnapshotList(prev => prev.filter(s => s.id !== id));
    } catch {}
  }

  const [showSnapshots, setShowSnapshots] = useState(false);
  const [snapshotList, setSnapshotList] = useState<MemorySnapshot[]>([]);
  const [restoreTarget, setRestoreTarget] = useState<MemorySnapshot | null>(null);
  const [restoreOpts, setRestoreOpts] = useState<{ conversation: boolean; memory: boolean; code: boolean }>({ conversation: true, memory: false, code: false });

  // 🧊 Freeze Brain � per-project pin to a snapshot's memory state
  const [freezeStatus, setFreezeStatus] = useState<{ frozen: boolean; snapshot?: { uid: string; label: string; tier: string | null } | null }>({ frozen: false, snapshot: null });

  async function loadFreezeStatus() {
    if (!activeProject) { setFreezeStatus({ frozen: false, snapshot: null }); return; }
    try {
      const res = await fetch(`/api/projects/${activeProject.id}/freeze`, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      setFreezeStatus({ frozen: !!data.frozen, snapshot: data.snapshot ?? null });
    } catch {}
  }

  async function freezeBrain(snapshotUid: string) {
    if (!activeProject) return;
    try {
      const res = await fetch(`/api/projects/${activeProject.id}/freeze`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot_uid: snapshotUid }),
      });
      if (!res.ok) return;
      await loadFreezeStatus();
      const snap = snapshotList.find(s => s.id === snapshotUid);
      addMessage('system', `🧊 Brain frozen to snapshot **"${snap?.label ?? snapshotUid}"**. SUNy will use this memory until you unfreeze.`);
    } catch {}
  }

  async function unfreezeBrain() {
    if (!activeProject) return;
    try {
      const res = await fetch(`/api/projects/${activeProject.id}/unfreeze`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) return;
      setFreezeStatus({ frozen: false, snapshot: null });
      addMessage('system', '🔥 Brain unfrozen. SUNy is back to live memory.');
    } catch {}
  }

  // Load snapshot count for button badge on mount, project change, or modal open
  useEffect(() => {
    loadSnapshots();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id]);

  useEffect(() => {
    if (showSnapshots) loadSnapshots();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSnapshots]);

  // Refresh freeze status whenever project changes
  useEffect(() => {
    loadFreezeStatus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id]);

  async function handleLogout() {
    await fetch('/api/logout', { method: 'POST', credentials: 'include' });
    onLogout();
  }

  const modes = userData?.modes || [];
  const noBalance = balance <= 0 && walletBalance <= 0;
  const activeSpend = activeProject ? projectSpend[activeProject.id] : null;

  return (
    <div className="chat-root" style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)' }}>
      {/* Top bar */}
      <div className="topbar" style={{
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        height: 52,
        borderBottom: '1px solid var(--border)',
        gap: 8,
        flexShrink: 0,
        position: 'relative',
      }}>
        {/* LEFT: brand + username + active project */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
          {/* Hamburger � visible only on mobile via CSS */}
          <button
            className="sidebar-toggle-btn"
            onClick={toggleSidebar}
            style={{
              display: 'none', /* hidden on desktop */
              background: 'none', border: 'none', color: 'var(--text-secondary)',
              cursor: 'pointer', padding: '4px', flexShrink: 0,
            }}
            title="Toggle sidebar"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <img src="/SLOGO.png" alt="SUNy" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, cursor: 'pointer' }} onClick={() => setActiveProject(null)} title="Global Chat" />
          <span className="suny-logo" style={{ fontWeight: 700, fontSize: 16, color: 'var(--accent)', marginRight: 2 }}>SUNy</span>
          <span className="topbar-tagline" style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', opacity: 0.75, whiteSpace: 'nowrap' }}>Consider it done.</span>
          {userData?.username && (
            <span className="topbar-username" style={{
              fontSize: 11, color: 'var(--text-secondary)',
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 120,
            }} title={userData.username}>
              {userData.username}
            </span>
          )}
          {activeProject && (
            <span style={{ color: 'var(--text-secondary)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}> {activeProject.name}</span>
          )}
          {activeSpend && (
            <span style={{ color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap', display: 'none' }}> {formatSpend(activeSpend.total_cost)}</span>
          )}
        </div>

        {/* CENTER: Mode selector + routing badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, justifyContent: 'center' }}>
          {modes.length > 0 && (
            <ModeSelector modes={modes} selected={selectedMode} onChange={changeMode} noBalance={noBalance} />
          )}
          
          {/* Connection status */}
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '2px 6px', borderRadius: 4,
              fontSize: 10, fontWeight: 600,
              color: isConnected ? 'var(--accent)' : 'var(--danger)',
              opacity: 0.7,
            }}
            title={isConnected ? 'Connected' : `Disconnected (${pendingCount} pending)`}
          >
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: isConnected ? 'var(--accent)' : 'var(--danger)',
              display: 'inline-block',
            }} />
            {!isConnected && pendingCount > 0 && (
              <span>{pendingCount}</span>
            )}
          </div>
        </div>

        {/* RIGHT: action buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, justifyContent: 'flex-end' }}>
          {activeProject && (
            <button
              className="btn btn-icon btn-secondary"
              onClick={() => {
                if (activeProject && messages.length > 0) saveProjectMessages(activeProject.id, messages);
                setActiveProject(null);
                setMessages([]);
              }}
              title="Home � back to global chat"
            >
              <Home size={15} />
            </button>
          )}
          {messages.length > 0 && (
            <>
              <button className="btn btn-icon btn-secondary" onClick={clearChat} title="Clear chat">
                <Eraser size={15} />
              </button>
              <button
                className="btn btn-icon btn-secondary"
                onClick={saveSnapshot}
                title="Save snapshot � store this chat + memory state for later restore"
              >
                <GitBranch size={15} />
              </button>
            </>
          )}
          {snapshotList.length > 0 && (
            <button
              className="btn btn-icon btn-secondary"
              onClick={() => setShowSnapshots(true)}
              title="Restore a memory snapshot"
              style={{ position: 'relative' }}
            >
              <GitBranch size={15} style={{ opacity: 0.6 }} />
              <span style={{
                position: 'absolute', top: 2, right: 2,
                width: 6, height: 6, borderRadius: '50%',
                background: 'var(--accent)', border: '1px solid var(--bg)',
              }} />
            </button>
          )}
          {!isMobile && (
            <BridgeStatusBadge
              connected={bridgeConnected}
              onClick={async () => {
                if (bridgeConnected) {
                  if (!confirm('?? Disconnect the SUNy Bridge?\n\nSUNy will no longer be able to read/write files or run commands on your machine. You can reconnect by clicking the bridge button again.')) return;
                  try {
                    await fetch('/api/bridge/disconnect', { method: 'POST', credentials: 'include' });
                    setBridgeConnected(false);
                  } catch { /* ignore */ }
                } else {
                  setShowBridgeTip(t => !t);
                }
              }}
            />
          )}
          {isMobile && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginRight: 4 }}>
              {['matrix', 'pro', 'suny'].map(t => (
                <button
                  key={t}
                  onClick={() => {
                    setUiTheme(t);
                    localStorage.setItem('suny_ui_theme', t);
                    localStorage.setItem('suny_dark_mode', String(t === 'matrix'));
                    document.body.classList.remove('theme-matrix', 'theme-pro', 'theme-suny', 'light-mode');
                    document.documentElement.classList.remove('theme-matrix', 'theme-pro', 'theme-suny');
                    if (t === 'pro') document.body.classList.add('theme-pro');
                    else if (t === 'suny') document.body.classList.add('theme-suny');
                    else document.body.classList.add('theme-matrix');
                  }}
                  style={{
                    background: uiTheme === t ? 'var(--accent)' : 'var(--surface)',
                    border: `1px solid ${uiTheme === t ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 4, cursor: 'pointer', padding: '2px 6px',
                    fontSize: 10, fontWeight: 600, color: uiTheme === t ? '#000' : 'var(--text-muted)',
                    lineHeight: '1.5',
                  }}
                  title={`${t.charAt(0).toUpperCase() + t.slice(1)} theme`}
                >
                  {t === 'matrix' ? '??' : t === 'pro' ? '?' : '??'}
                </button>
              ))}
            </div>
          )}
          <UpgradePROButton plan={userData?.plan} upgradePending={userData?.upgrade_pending} />
          <BalanceBadge
            balance={balance}
            walletBalance={walletBalance}
            remainingTokens={sessLimit == null ? null : Math.max(0, sessLimit - sessUsed)}
            onOpenWalletSettings={() => onOpenSettings('wallet', 'Opened Wallet Transfer in Settings')}
          />
          <button
            className="btn btn-icon btn-secondary"
            onClick={() => { setTopUpResult(null); setShowTopUp(true); }}
            title="Request a top-up"
            style={{ fontSize: 12 }}
          >+ Top up</button>
          {!isMobile && (
            <button
              className="btn btn-icon btn-secondary"
              onClick={() => { setShowUsage(true); loadUsageStats(usageDays); }}
              title="Usage stats"
            >
              <BarChart2 size={15} />
            </button>
          )}
          {!isMobile && (
            <button className="btn btn-icon btn-secondary" onClick={() => setShowHelp(true)} title="Keyboard shortcuts & help">
              <HelpCircle size={15} />
            </button>
          )}
          <button className="btn btn-icon btn-secondary" onClick={() => onOpenSettings()} title="Settings">
            <Settings size={15} />
          </button>
          {!isMobile && (
            <button className="btn btn-icon btn-secondary" onClick={() => navigate('/contact')} title="Contact Us">
              <Phone size={15} />
            </button>
          )}
          <button className="btn btn-icon btn-secondary" onClick={handleLogout} title="Sign out">
            <LogOut size={15} />
          </button>
        </div>
      </div>

      {/* Body: sidebar + chat area */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {/* Sidebar overlay backdrop � only shown on mobile when sidebar is open */}
        {sidebarOpen && (
          <div className="sidebar-overlay" onClick={closeSidebar} style={{ display: 'none' }} />
        )}
        {/* Projects sidebar */}
        <div className={`sidebar${sidebarOpen ? ' sidebar-open' : ''}`} style={{
          width: 220,
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          padding: '12px 0',
          flexShrink: 0,
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
                  title={showFileBrowser ? 'Hide file browser' : (bridgeConnected ? 'Show file browser' : 'Bridge required � click to connect')}
                >
                  {showFileBrowser ? <FolderOpen size={12} /> : <Folder size={12} />}
                </button>
              )}
              <button className="btn btn-icon btn-secondary btn-sm" onClick={() => { setNewProjectMode('link'); setScratchDescription(''); setShowNewProject(true); }} title="New project">
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
                    onClick={() => {
                      openProject(p);
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
                    <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{
                          fontSize: 13,
                          color: activeProject?.id === p.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
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

          {/* Client Tickets navigation link */}
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
            <div
              onClick={() => navigate('/client-tickets')}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 12px', cursor: 'pointer',
                fontSize: 13, color: 'var(--text-secondary)',
                transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
              title="Manage client tickets"
            >
              <Link size={14} />
              <span>Client Tickets</span>
            </div>
          </div>

          {/* Archived tabs section */}
          {(() => {
            const archivedTabs = globalTabs.filter(t => t.archived);
            if (archivedTabs.length === 0) return null;
            return (
              <div style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
                <div style={{ padding: '12px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span
                    style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                    onClick={() => setCollapsedSections(s => ({ ...s, archived: !s.archived }))}
                  >
                    {collapsedSections.archived ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                    Archived ({archivedTabs.length})
                  </span>
                </div>
                {!collapsedSections.archived && (
                  <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                    {archivedTabs.map(tab => (
                      <div
                        key={tab.id}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '6px 12px', borderBottom: '1px solid var(--border)',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                          <ArchiveRestore size={11} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                          <span style={{ fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {tab.name}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                          <button
                            onClick={e => { e.stopPropagation(); unarchiveGlobalTab(tab.id); }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', padding: 2 }}
                            title="Unarchive tab"
                          >
                            <ArchiveRestore size={11} />
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); deleteArchivedTab(tab.id); }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2 }}
                            title="Delete archived tab"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Memories section */}
          {activeProject && !isMobile && (
            <>
              <div style={{
                padding: '16px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                borderTop: '1px solid var(--border)', marginTop: 4,
              }}>
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
            </>
          )}

          {/* Project Auto-Execute section */}
          {activeProject && !isMobile && (
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
              <div style={{ padding: '12px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span
                  style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                  onClick={() => setCollapsedSections(s => ({ ...s, autoExecute: !s.autoExecute }))}
                >
                  {collapsedSections.autoExecute ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                  Auto-Execute
                </span>
              </div>
              {!collapsedSections.autoExecute && (
                <div style={{ padding: '0 12px 10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      {activeProject.auto_execute_override == null
                        ? `Using global setting: ${globalAutoApprove ? 'ON' : 'OFF'}`
                        : `Project override: ${activeProject.auto_execute_override ? 'ON' : 'OFF'}`}
                    </div>
                    <input
                      type="checkbox"
                      className="toggle"
                      checked={activeProject.auto_execute_override == null ? globalAutoApprove : activeProject.auto_execute_override}
                      onChange={e => saveProjectAutoExecuteOverride(e.target.checked)}
                      title="Toggle auto-execute for this project"
                    />
                  </div>
                  {activeProject.auto_execute_override != null && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => saveProjectAutoExecuteOverride(null)}
                      style={{ marginTop: 8, fontSize: 10, padding: '3px 8px' }}
                      title="Use global default for this project"
                    >
                      Use global default
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 🧊 Freeze Brain section � pin SUNy's memory to a snapshot */}
          {activeProject && !isMobile && (
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
              <div style={{ padding: '12px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span
                  style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                  onClick={() => setCollapsedSections(s => ({ ...s, freezeBrain: !s.freezeBrain }))}
                >
                  {collapsedSections.freezeBrain ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                  🧊 Freeze Brain
                </span>
                {freezeStatus.frozen && (
                  <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: 'var(--accent)', color: '#fff' }}>ACTIVE</span>
                )}
              </div>
              {!collapsedSections.freezeBrain && (
                <div style={{ padding: '0 12px 10px' }}>
                {freezeStatus.frozen && freezeStatus.snapshot ? (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 6 }}>
                      Pinned to: <strong>{freezeStatus.snapshot.label}</strong>
                      {freezeStatus.snapshot.tier ? ` � tier ${freezeStatus.snapshot.tier}` : ''}
                    </div>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={unfreezeBrain}
                      style={{ fontSize: 10, padding: '3px 8px', width: '100%' }}
                      title="Resume live memory (blueprint + rules from current state)"
                    >
                      🔥 Unfreeze
                    </button>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 6 }}>
                      Pin SUNy's blueprint + behavioral rules to a saved snapshot. Live learning is paused for this project.
                    </div>
                    {snapshotList.filter(s => s.has_memory).length === 0 ? (
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                        Save a snapshot with memory first (📸 button).
                      </div>
                    ) : (
                      <select
                        defaultValue=""
                        onChange={e => { if (e.target.value) freezeBrain(e.target.value); }}
                        className="input"
                        style={{ width: '100%', fontSize: 11, padding: '4px 6px' }}
                        title="Select a snapshot to freeze"
                      >
                        <option value="">Select snapshot to freeze...</option>
                        {snapshotList.filter(s => s.has_memory).map(s => (
                          <option key={s.id} value={s.id}>{s.label}{s.tier ? ` (${s.tier})` : ''}</option>
                        ))}
                      </select>
                    )}
                  </>
                )}
                </div>
              )}
            </div>
          )}

          {/* Project Default Tier section */}
          {activeProject && !isMobile && (
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
              <div style={{ padding: '12px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span
                  style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                  onClick={() => setCollapsedSections(s => ({ ...s, defaultTier: !s.defaultTier }))}
                >
                  {collapsedSections.defaultTier ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                  Default Tier
                </span>
              </div>
              {!collapsedSections.defaultTier && (
                <div style={{ padding: '0 12px 10px' }}>
                  <select
                    value={activeProject.default_tier ?? ''}
                    onChange={e => {
                      const v = e.target.value;
                      saveProjectDefaultTier(v === '' ? null : (v as 'free' | 'fast' | 'pro' | 'auto'));
                    }}
                    className="input"
                    style={{ width: '100%', fontSize: 12, padding: '4px 6px' }}
                    title="Default model tier for this project (overrides your account default)"
                  >
                    <option value="">Inherit account default</option>
                    <option value="free">Free</option>
                    <option value="fast">Fast</option>
                    <option value="pro">Pro</option>
                    <option value="auto">Auto</option>
                  </select>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>
                    Used when you don't pick a tier for a message.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Project Rules (.suny-rules) section */}
          {activeProject && !isMobile && (
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
                  {projectRules.slice(0, 300)}{projectRules.length > 300 ? '�' : ''}
                </div>
              ) : (
                <p style={{ padding: '0 12px 8px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  No rules set. Click the edit icon to add coding guidelines for this project.
                </p>
              ))}
            </div>
          )}

          {/* Persona section */}
          {activeProject && !isMobile && (
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
                  {activeProject.persona.slice(0, 200)}{(activeProject.persona?.length ?? 0) > 200 ? '�' : ''}
                </div>
              ) : (
                <p style={{ padding: '0 12px 8px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  No persona. Click the user icon to give SUNy a role for this project.
                </p>
              ))}
            </div>
          )}

          {/* Blueprint Memory Graph section */}
          {activeProject && !isMobile && blueprintEntries.length > 0 && (
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
                >
                  ?
                </button>
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
                          ? {e.intent}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* File Browser section */}
          {activeProject && !isMobile && showFileBrowser && (
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
              <div style={{ padding: '12px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Files
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {vectorIndexStats && vectorIndexStats.projectId === activeProject.id && (
                    <span title={`${vectorIndexStats.chunks} code chunks indexed across ${vectorIndexStats.files} files`} style={{
                      fontSize: 9, color: 'var(--accent)', fontWeight: 600, padding: '1px 5px',
                      background: 'rgba(108,99,255,0.12)', borderRadius: 3, cursor: 'default',
                    }}>
                      ? {vectorIndexStats.chunks} chunks
                    </span>
                  )}
                  <button
                    className="btn btn-icon btn-sm"
                    onClick={triggerReindex}
                    disabled={reindexing}
                    title="Re-index project for vector context"
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', padding: 2, cursor: 'pointer',
                      animation: reindexing ? 'spin 1s linear infinite' : 'none' }}
                  >
                    ?
                  </button>
                  <button
                    className="btn btn-icon btn-sm"
                    onClick={() => loadFileBrowser(activeProject.id)}
                    title="Refresh file list"
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', padding: 2, cursor: 'pointer' }}
                  >
                    ?
                  </button>
                </div>
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto', fontSize: 11 }}>
                {fileBrowser.length === 0 && (
                  <p style={{ padding: '0 12px 8px', color: 'var(--text-muted)' }}>No files loaded.</p>
                )}
                {pinnedFiles.size > 0 && (
                  <div style={{ padding: '4px 12px 4px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 600, marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                      ?? Pinned ({pinnedFiles.size})
                    </div>
                    {[...pinnedFiles].map(fp => (
                      <div key={fp} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 0' }}>
                        <span style={{ flex: 1, fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fp}</span>
                        <button onClick={() => togglePinFile({ name: fp.split('/').pop()!, path: fp, isDir: false })}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 1 }}
                          title="Unpin"><Check size={12} /><X size={12} /></button>
                      </div>
                    ))}
                  </div>
                )}
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
                    pinnedFiles={pinnedFiles}
                    onPinToggle={togglePinFile}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Live Server section */}
          {activeProject && !isMobile && bridgeConnected && (
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
              <div style={{ padding: '12px 12px 8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Dev Server
                  </span>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    {devServerRunning && (
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', display: 'inline-block' }} />
                    )}
                  </div>
                </div>
                {devServerRunning && devServerUrl ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <a
                      href={devServerUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {devServerUrl}
                    </a>
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ fontSize: 11, padding: '3px 8px', color: 'var(--error)', borderColor: 'var(--error)' }}
                      onClick={stopDevServer}
                      disabled={devServerLoading}
                    >
                      {devServerLoading ? '�' : 'Stop'}
                    </button>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                      Dev server ON means your app is running live for preview/testing. Turning it OFF only stops preview, not SUNy file access.
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ fontSize: 11, padding: '4px 10px', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                      onClick={() => { if (!bridgeConnected) { setShowBridgeTip(true); return; } startDevServer(); }}
                      disabled={devServerLoading}
                    >
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
          {activeProject && !isMobile && checkpoints.length > 0 && (
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
                  ?
                </button>
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
                          <button
                            className="btn btn-sm"
                            onClick={() => rollbackToCheckpoint(cp.sha)}
                            disabled={rollingBack === cp.sha}
                            style={{ fontSize: 10, padding: '2px 5px', background: 'var(--error)', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer' }}
                          >
                            {rollingBack === cp.sha ? '�' : 'Yes'}
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => setRollbackConfirm(null)}
                            style={{ fontSize: 10, padding: '2px 5px', background: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 3, cursor: 'pointer' }}
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <button
                          className="btn btn-sm btn-secondary"
                          onClick={() => setRollbackConfirm(cp.sha)}
                          disabled={!!rollingBack}
                          title="Roll back to this checkpoint"
                          style={{ fontSize: 10, padding: '2px 6px', flexShrink: 0 }}
                        >
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

        {/* Chat area */}
        <div className="chat-main" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
          <ChatMessages
            messages={messages}
            activeProject={activeProject}
            thinking={thinking}
            streamingContent={streamingContent}
            thinkingStatus={thinkingStatus}
            proofRuns={proofRuns}
            globalTabs={globalTabs}
            activeTabId={activeTabId}
            renamingTabId={renamingTabId}
            renamingTabValue={renamingTabValue}
            deleteConfirmTabId={deleteConfirmTabId}
            projectStateReady={projectStateReady}
            globalIntroLine={globalIntroLine}
            projects={projects}
            bridgeConnected={bridgeConnected}
            expandedRunIds={expandedRunIds}
            msgEndRef={msgEndRef}
            clearChat={clearChat}
            onDeleteMessage={deleteMessage}
            onRegenerateMessage={regenerateUserMessage}
            onEditMessage={editUserMessage}
            setRenamingTabId={setRenamingTabId}
            setRenamingTabValue={setRenamingTabValue}
            setDeleteConfirmTabId={setDeleteConfirmTabId}
            switchGlobalTab={switchGlobalTab}
            closeGlobalTab={closeGlobalTab}
            addGlobalTab={addGlobalTab}
            archiveGlobalTab={archiveGlobalTab}
            deleteArchivedTab={deleteArchivedTab}
            renameGlobalTab={renameGlobalTab}
            setShowBridgeTip={setShowBridgeTip}
            openProject={openProject}
            copyProofReportToClipboard={copyProofReportToClipboard}
            setExpandedRunIds={setExpandedRunIds}
            toolLabel={toolLabel}
          />
          {queuedPrompt && (
            <div style={{
              background: 'var(--surface-sunken)',
              border: '1px solid var(--border-color)',
              borderRadius: 8,
              padding: '12px 16px',
              margin: '0 24px -8px 24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              zIndex: 10,
              boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
            }}>
              {queuedPrompt.status === 'queued' ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                    <span style={{ fontSize: 14, color: 'var(--text-muted)' }}>
                      <strong>Queued:</strong> {queuedPrompt.text.length > 50 ? queuedPrompt.text.substring(0, 50) + '...' : queuedPrompt.text}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => setQueuedPrompt(null)}>Cancel</button>
                    <button className="btn btn-primary btn-sm" onClick={() => {
                      wsSend({ type: 'chat:cancel' });
                      setTimeout(() => {
                        wsSend(queuedPrompt.payload);
                        setImagePreview(null);
                        setQueuedPrompt(null);
                      }, 300);
                    }}>Force execute now!</button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontSize: 14, color: '#f87171', fontWeight: 'bold' }}>
                      Interrupting current task in {queuedPrompt.timeLeft}s...
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => setQueuedPrompt(null)}>Cancel</button>
                    <button className="btn btn-primary btn-sm" onClick={() => setQueuedPrompt(prev => prev ? { ...prev, status: 'queued' } : null)}>Queue instead</button>
                  </div>
                </>
              )}
            </div>
          )}
          {/* 80% budget warning banner */}
          {budgetWarning && (
            <div style={{
              margin: '0 12px 6px', padding: '8px 12px',
              background: 'color-mix(in srgb, var(--warning, #f59e0b) 12%, var(--surface))',
              border: '1px solid color-mix(in srgb, var(--warning, #f59e0b) 40%, transparent)',
              borderRadius: 7, display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ fontSize: 15 }}>⚠️</span>
              <span style={{ fontSize: 12, color: 'var(--text-primary)', flex: 1 }}>
                <strong>{Math.round(budgetWarning.pct * 100)}% of run budget used</strong>
                {' '}— ${budgetWarning.spent.toFixed(4)} of ${budgetWarning.cap.toFixed(4)}
              </span>
              <button onClick={() => setBudgetWarning(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, padding: '0 2px' }}>✕</button>
            </div>
          )}

          {/* 90% budget gate card */}
          {budgetGateOpen && (
            <div style={{
              margin: '0 12px 8px', padding: '14px',
              background: 'color-mix(in srgb, #f59e0b 10%, var(--surface))',
              border: '2px solid color-mix(in srgb, #f59e0b 60%, transparent)',
              borderRadius: 10,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 18 }}>🔒</span>
                <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>90% Budget Reached</strong>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                  ${budgetGateOpen.spent.toFixed(4)} / ${budgetGateOpen.cap.toFixed(4)}
                </span>
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.5 }}>
                SUNy has used 90% of your run budget. Choose how to proceed:
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                <button
                  className="btn btn-sm"
                  style={{ background: 'var(--accent)', color: '#fff', border: 'none', textAlign: 'left', padding: '8px 12px', borderRadius: 6, cursor: 'pointer' }}
                  onClick={() => { wsSend({ type: 'budget_gate:budget_mode' }); setBudgetGateOpen(null); }}
                >
                  <strong>⚡ Budget Mode</strong> — SUNy re-plans and finishes the task with minimum tokens
                </button>
                <button
                  className="btn btn-sm btn-secondary"
                  style={{ textAlign: 'left', padding: '8px 12px', borderRadius: 6 }}
                  onClick={() => { wsSend({ type: 'budget_gate:continue' }); setBudgetGateOpen(null); }}
                >
                  <strong>▶ Continue anyway</strong> — keep going beyond the cap
                </button>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="number" min="0.001" step="0.01"
                    className="input"
                    placeholder={`Extend to $... (current: $${budgetGateOpen.cap.toFixed(4)})`}
                    value={budgetExtendInput}
                    onChange={e => setBudgetExtendInput(e.target.value)}
                    style={{ flex: 1, fontSize: 12 }}
                  />
                  <button
                    className="btn btn-sm btn-secondary"
                    disabled={!budgetExtendInput || parseFloat(budgetExtendInput) <= budgetGateOpen.cap}
                    onClick={() => {
                      const newCap = parseFloat(budgetExtendInput);
                      if (isFinite(newCap) && newCap > budgetGateOpen.cap) {
                        wsSend({ type: 'budget_gate:extend', newCap });
                        setBudgetGateOpen(null);
                        setBudgetExtendInput('');
                      }
                    }}
                  >
                    💰 Extend Budget
                  </button>
                </div>
                <button
                  className="btn btn-sm"
                  style={{ background: 'var(--error)', color: '#fff', border: 'none', padding: '8px 12px', borderRadius: 6, cursor: 'pointer' }}
                  onClick={() => { wsSend({ type: 'budget_gate:stop' }); setBudgetGateOpen(null); }}
                >
                  🛑 Stop here — save what's done
                </button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                Budget Mode uses minimum steps to complete the task. If you stop, all work up to this point is saved.
              </div>
            </div>
          )}

          {/* Pre-run cost estimate card */}
          {forecastLoading && (
            <div style={{ margin: '0 12px 8px', padding: '10px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 14 }}>📋</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Estimating run cost…</span>
            </div>
          )}
          {forecastEstimate && (
            <div style={{
              margin: '0 12px 8px', padding: '12px 14px',
              background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))',
              border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)',
              borderRadius: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 16 }}>📋</span>
                <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>Cost Estimate</strong>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                  {forecastEstimate.confidence} confidence · {forecastEstimate.basedOn === 'history' ? `${forecastEstimate.historicalSamples} past runs` : forecastEstimate.basedOn === 'llm_estimate' ? 'AI estimate' : 'default estimate'}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                <div style={{ background: 'var(--surface)', borderRadius: 6, padding: '6px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>ESTIMATED COST</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                    ${forecastEstimate.lowCredits.toFixed(4)}–${forecastEstimate.highCredits.toFixed(4)}
                  </div>
                </div>
                <div style={{ background: 'var(--surface)', borderRadius: 6, padding: '6px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>YOUR BALANCE</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: forecastEstimate.currentBalance < forecastEstimate.highCredits ? 'var(--error)' : 'var(--success)', fontFamily: 'monospace' }}>
                    ${forecastEstimate.currentBalance.toFixed(4)}
                  </div>
                </div>
                {forecastEstimate.estimatedSteps > 0 && (
                  <div style={{ background: 'var(--surface)', borderRadius: 6, padding: '6px 10px', textAlign: 'center' }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>EST. STEPS</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                      ~{forecastEstimate.estimatedSteps}
                    </div>
                  </div>
                )}
              </div>
              {forecastEstimate.currentBalance < forecastEstimate.lowCredits && (
                <div style={{ fontSize: 11, color: 'var(--error)', marginBottom: 8 }}>⚠️ Balance may be insufficient for this run.</div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => { wsSend({ type: 'checkpoint:approve' }); setForecastEstimate(null); }}
                  style={{ flex: 1 }}
                >
                  ▶ Run
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => { wsSend({ type: 'checkpoint:abort' }); setForecastEstimate(null); }}
                  style={{ flex: 1 }}
                >
                  ✕ Cancel
                </button>
              </div>
            </div>
          )}

          {checkpoint && (
            <div style={{
              margin: '0 12px 8px',
              padding: '12px 14px',
              borderRadius: 10,
              border: '1px solid rgba(251,191,36,0.5)',
              background: 'rgba(251,191,36,0.07)',
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16 }}>⚠️</span>
                <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>{checkpoint.label}</strong>
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>{checkpoint.details}</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => { wsSend({ type: 'checkpoint:approve' }); setCheckpoint(null); }}
                  style={{ background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.4)', color: '#22c55e' }}
                >✓ Proceed</button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => { wsSend({ type: 'checkpoint:abort' }); setCheckpoint(null); }}
                  style={{ color: 'var(--error)' }}
                >✕ Abort</button>
              </div>
            </div>
          )}
          <ChatInput
            input={input}
            setInput={setInput}
            balance={balance}
            walletBalance={walletBalance}
            thinking={thinking}
            selectedMode={selectedMode}
            activeProject={activeProject}
            bridgeConnected={bridgeConnected}
            talkMode={talkMode}
            noBalance={noBalance}
            imagePreview={imagePreview}
            setImagePreview={setImagePreview}
            inputRef={inputRef}
            inputHistoryIndex={inputHistoryIndex}
            messages={messages}
            sendMessage={sendMessage}
            toggleTalkMode={toggleTalkMode}
            wsSend={wsSend}
            addMessage={addMessage}
            isListening={isListening}
            onVoiceToggle={toggleVoice}
          />
        </div>
      </div>

      {/* Bridge connect modal */}
      {showBridgeTip && (
        <div className="modal-overlay" onClick={() => setShowBridgeTip(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
            {bridgeConnected ? (
              <>
                <div style={{ textAlign: 'center', padding: '12px 0 8px' }}>
                  <div style={{ fontSize: 32, marginBottom: 6 }}>?</div>
                  <h3 style={{ margin: '0 0 6px', fontSize: 17 }}>Bridge connected!</h3>
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                    SUNy can now read &amp; write files, run shell commands, fix lint errors, and auto-commit.
                  </p>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                  <button className="btn btn-primary" onClick={() => setShowBridgeTip(false)}>Close</button>
                </div>
              </>
            ) : (
              <>
                <h3 style={{ margin: '0 0 4px', fontSize: 17 }}>🔌 Connect the Bridge</h3>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, margin: '0 0 6px' }}>
                  The Bridge is a small background process that runs on <strong>your computer</strong>.
                  SUNy needs it to <strong>create files, edit code, and run commands</strong>.
                </p>

                {/* Capability comparison */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                  <div style={{ flex: 1, background: 'var(--bg-secondary)', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Without Bridge</div>
                    {['💬 Chat & answer questions', '🔍 Code review & analysis', '🏛️ Architecture advice'].map(t => (
                      <div key={t} style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 3 }}>{t}</div>
                    ))}
                  </div>
                  <div style={{ flex: 1, background: 'rgba(108,99,255,0.07)', border: '1px solid rgba(108,99,255,0.2)', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.4px' }}>With Bridge ⚡</div>
                    {['✏️ Create & edit files', '⚙️ Run shell commands', '🔧 Auto-fix lint errors', '📝 Git auto-commit'].map(t => (
                      <div key={t} style={{ fontSize: 12, color: 'var(--text-primary)', marginBottom: 3 }}>{t}</div>
                    ))}
                  </div>
                </div>

                <BridgeInstallInstructions autoCopy previouslyConnected={bridgePreviouslyConnected} />

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                  <button className="btn btn-secondary" onClick={() => setShowBridgeTip(false)}>Close</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Top-up request modal */}
      {showTopUp && (
        <div className="modal-overlay" onClick={() => { if (!topUpSubmitting) { setShowTopUp(false); setTopUpResult(null); } }}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 17 }}>?? Request a top-up</h3>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, margin: '0 0 14px' }}>
              Submit a top-up request. An admin will review and credit your wallet.
            </p>
            {topUpResult ? (
              <>
                <div style={{
                  padding: 12, borderRadius: 8, marginBottom: 14,
                  background: topUpResult.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                  border: `1px solid ${topUpResult.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                  fontSize: 13,
                }}>{topUpResult.msg}</div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button className="btn btn-primary" onClick={() => { setShowTopUp(false); setTopUpResult(null); }}>Close</button>
                </div>
              </>
            ) : (
              <>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Amount (USD)</label>
                <input
                  type="number" min="1" max="10000" step="1"
                  value={topUpAmount}
                  onChange={e => setTopUpAmount(e.target.value)}
                  className="input"
                  style={{ width: '100%', marginBottom: 12 }}
                  disabled={topUpSubmitting}
                />
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Note (optional)</label>
                <textarea
                  value={topUpNote}
                  onChange={e => setTopUpNote(e.target.value.slice(0, 500))}
                  className="input"
                  style={{ width: '100%', minHeight: 60, marginBottom: 14, resize: 'vertical' }}
                  placeholder="Payment method, reference, etc."
                  disabled={topUpSubmitting}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button className="btn btn-secondary" disabled={topUpSubmitting} onClick={() => setShowTopUp(false)}>Cancel</button>
                  <button
                    className="btn btn-primary"
                    disabled={topUpSubmitting || !topUpAmount || Number(topUpAmount) <= 0}
                    onClick={async () => {
                      setTopUpSubmitting(true);
                      try {
                        const res = await fetch('/api/billing/topup-request', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          credentials: 'include',
                          body: JSON.stringify({ amount: Number(topUpAmount), note: topUpNote }),
                        });
                        const data = await res.json().catch(() => ({}));
                        if (res.ok) {
                          setTopUpResult({ ok: true, msg: '? Request submitted. An admin will review it shortly. You\'ll be notified when it\'s resolved.' });
                          setTopUpNote('');
                        } else {
                          setTopUpResult({ ok: false, msg: '? ' + (data.error || `Request failed (${res.status})`) });
                        }
                      } catch (err) {
                        setTopUpResult({ ok: false, msg: '? Network error: ' + String(err) });
                      } finally {
                        setTopUpSubmitting(false);
                      }
                    }}
                  >{topUpSubmitting ? 'Submitting�' : 'Submit request'}</button>
                </div>
              </>
            )}
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
              Project Rules � {activeProject.name}
            </h3>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
              These rules are saved to <code style={{ background: 'var(--bg)', padding: '1px 4px', borderRadius: 3 }}>.suny-rules</code> in your project folder and injected into every conversation for this project.
              <br />Write coding preferences, forbidden patterns, naming conventions, or anything SUNy should always follow.
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
        <div className="modal-overlay" onClick={() => { setShowNewProject(false); setNewProjectMode('link'); setScratchDescription(''); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">New Project</h3>

            {/* Tab switcher */}
            <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
              <button
                onClick={() => setNewProjectMode('link')}
                style={{
                  flex: 1, padding: '7px 0', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
                  background: newProjectMode === 'link' ? 'var(--accent)' : 'transparent',
                  color: newProjectMode === 'link' ? '#fff' : 'var(--text-muted)',
                }}
              >
                Link Existing
              </button>
              <button
                onClick={() => setNewProjectMode('scratch')}
                style={{
                  flex: 1, padding: '7px 0', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
                  background: newProjectMode === 'scratch' ? 'var(--accent)' : 'transparent',
                  color: newProjectMode === 'scratch' ? '#fff' : 'var(--text-muted)',
                }}
              >
                Build with SUNy
              </button>
            </div>

            {newProjectMode === 'link' ? (
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
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Project Folder</label>
                {/* Primary: big folder pick button */}
                <button
                  type="button"
                  onClick={() => {
                    pickFolderPath((picked) => {
                      setNewProjectPath(picked);
                      const parts = picked.replace(/\\/g, '/').split('/').filter(Boolean);
                      if (!newProjectName) setNewProjectName(parts[parts.length - 1] || '');
                    });
                  }}
                  style={{
                    width: '100%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                    padding: '14px 0', borderRadius: 8, border: '2px dashed var(--border)',
                    cursor: 'pointer', marginBottom: 8, color: 'var(--text-muted)',
                    background: 'var(--bg-secondary)',
                    transition: 'border-color 0.2s',
                  }}
                  title="Choose folder"
                  onMouseEnter={e => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)')}
                  onMouseLeave={e => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--border)')}
                >
                  <FolderOpen size={22} style={{ color: 'var(--accent)' }} />
                  <span style={{ fontSize: 13 }}>{newProjectPath ? newProjectPath : 'Click to choose a folder'}</span>
                </button>
                {/* Fallback: manual text input */}
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={newProjectPath}
                    onChange={e => { setNewProjectPath(e.target.value); setNewProjectPathError(''); }}
                    placeholder="Or type path manually, e.g. C:\\Users\\me\\projects\\my-app"
                    style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, flex: 1, borderColor: newProjectPathError ? 'var(--color-error, #e74c3c)' : undefined }}
                  />
                </div>
                {newProjectPathError && (
                  <div style={{ fontSize: 12, color: 'var(--color-error, #e74c3c)', marginTop: 4 }}>
                    {newProjectPathError}
                  </div>
                )}
              </div>
            </div>
            ) : (
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
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Where to create it</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={newProjectPath}
                    onChange={e => { setNewProjectPath(e.target.value); setNewProjectPathError(''); }}
                    placeholder="e.g. C:\\Users\\me\\projects"
                    style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, flex: 1 }}
                  />
                  <button
                    className="btn btn-secondary"
                    type="button"
                    style={{ whiteSpace: 'nowrap', marginBottom: 0 }}
                    title="Browse parent folder"
                    onClick={() => pickFolderPath(setNewProjectPath)}
                  >
                    Browse
                  </button>
                </div>
                {newProjectPathError && (
                  <div style={{ fontSize: 12, color: 'var(--color-error, #e74c3c)', marginTop: 4 }}>
                    {newProjectPathError}
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  SUNy will create a <code>{newProjectName || 'project'}</code> subfolder here.
                </div>
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                  <Sparkles size={12} style={{ marginRight: 4 }} />
                  Describe what you want to build
                </label>
                <textarea
                  value={scratchDescription}
                  onChange={e => setScratchDescription(e.target.value)}
                  placeholder="e.g. A to-do app with React and a dark theme, with the ability to add, delete, and mark tasks as done."
                  rows={4}
                  style={{ width: '100%', fontFamily: 'inherit', fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }}
                />
              </div>
            </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => { setShowNewProject(false); setNewProjectMode('link'); setScratchDescription(''); }}>Cancel</button>
              {newProjectMode === 'link' ? (
                <button className="btn btn-primary" onClick={createProject}>Create with SUNy</button>
              ) : (
                <button
                  className="btn btn-primary"
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                  onClick={async () => {
                    if (!newProjectName.trim() || !newProjectPath.trim()) {
                      setNewProjectPathError('Please fill in all fields.');
                      return;
                    }
                    const fullPath = newProjectPath.replace(/\\/g, '/') + '/' + newProjectName.trim().replace(/\s+/g, '-').toLowerCase();
                    await fetch('/api/projects', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      credentials: 'include',
                      body: JSON.stringify({ name: newProjectName.trim(), local_path: fullPath }),
                    }).then(async r => {
                      if (r.ok) {
                        const created = await r.json();
                        const loaded = await fetch('/api/projects', { credentials: 'include' }).then(x => x.json());
                        setProjects(loaded);
                        const found = loaded.find((p: Project) => p.id === created.id);
                        if (found) { openProject(found); }
                        setShowNewProject(false);
                        setNewProjectMode('link');
                        const prompt = `Build with SUNy from scratch.\n\nDescription: ${scratchDescription.trim()}\n\nPlease scaffold the folder structure and all necessary files.`;
                        setScratchDescription('');
                        setInput(prompt);
                      }
                    }).catch(() => {});
                  }}
                >
                  <Sparkles size={13} />
                  Build with SUNy
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Persona Editor Modal */}
      {showPersonaEditor && activeProject && (
        <div className="modal-overlay" onClick={() => setShowPersonaEditor(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <h3 className="modal-title">
              <User size={16} style={{ marginRight: 8, verticalAlign: 'text-bottom' }} />
              AI Persona � {activeProject.name}
            </h3>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
              Give SUNy a specific role or personality for this project. This is injected into every conversation.
              <br />Examples: <em>"Act as a senior Rails engineer. Never suggest Python."</em> or <em>"You are a security-focused code reviewer."</em>
            </p>
            <textarea
              value={personaEditorContent}
              onChange={e => setPersonaEditorContent(e.target.value)}
              placeholder="Act as a senior TypeScript engineer focused on clean architecture. Prefer functional patterns. Never use any."
              rows={6}
              autoFocus
              style={{ width: '100%', resize: 'vertical', boxSizing: 'border-box', fontSize: 13 }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowPersonaEditor(false)}>Cancel</button>
              {activeProject.persona && (
                <button
                  className="btn btn-secondary"
                  style={{ color: 'var(--error)', borderColor: 'var(--error)' }}
                  onClick={() => savePersonaApi('')}
                >
                  <Trash2 size={13} style={{ marginRight: 6 }} />Clear
                </button>
              )}
              <button className="btn btn-primary" onClick={() => savePersonaApi(personaEditorContent)}>
                Save Persona
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Memory Snapshots Modal */}
      {showSnapshots && (
        <div className="modal-overlay" onClick={() => setShowSnapshots(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 className="modal-title" style={{ margin: 0 }}>
                <GitBranch size={15} style={{ marginRight: 8, verticalAlign: 'text-bottom' }} />
                Memory Snapshots
              </h3>
              <button className="btn btn-icon btn-secondary" onClick={() => setShowSnapshots(false)}><X size={14} /><Check size={12} /><X size={12} /></button>
            </div>
            {snapshotList.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>No snapshots saved yet. Use the ?? button to capture this chat + memory state.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {snapshotList.map(snap => (
                  <div key={snap.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px', borderRadius: 8,
                    border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {snap.label}
                        {snap.kind === 'auto' && <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--accent)', color: '#fff', opacity: 0.7 }}>AUTO</span>}
                        {snap.has_memory && <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.6 }}>??</span>}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                        {snap.message_count} msgs{snap.tier ? ` � tier ${snap.tier}` : ''} � {new Date(snap.savedAt).toLocaleString()}
                      </div>
                    </div>
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => {
                        setRestoreTarget(snap);
                        setRestoreOpts({ conversation: true, memory: snap.has_memory, code: false });
                      }}
                    >Restore</button>
                    <button className="btn btn-sm btn-secondary" onClick={() => deleteSnapshot(snap.id)}><Trash2 size={12} /><Check size={12} /><X size={12} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Selective Restore Sub-Modal */}
      {restoreTarget && (
        <div className="modal-overlay" onClick={() => setRestoreTarget(null)} style={{ zIndex: 1100 }}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 className="modal-title" style={{ margin: 0 }}>Restore � what to bring back?</h3>
              <button className="btn btn-icon btn-secondary" onClick={() => setRestoreTarget(null)}><X size={14} /><Check size={12} /><X size={12} /></button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 0, marginBottom: 12 }}>
              From snapshot: <strong>{restoreTarget.label}</strong>
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={restoreOpts.conversation} onChange={e => setRestoreOpts(o => ({ ...o, conversation: e.target.checked }))} />
                <span>💬 <strong>Conversation</strong> � replace current messages ({restoreTarget.message_count})</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: restoreTarget.has_memory ? 'pointer' : 'not-allowed', opacity: restoreTarget.has_memory ? 1 : 0.4 }}>
                <input type="checkbox" disabled={!restoreTarget.has_memory} checked={restoreOpts.memory} onChange={e => setRestoreOpts(o => ({ ...o, memory: e.target.checked }))} />
                <span>🧠 <strong>Memory</strong> � blueprint + behavioral rules + tier{!restoreTarget.has_memory && ' (none captured)'}</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={restoreOpts.code} onChange={e => setRestoreOpts(o => ({ ...o, code: e.target.checked }))} />
                <span>💾 <strong>Code</strong> � rollback to linked checkpoint (if any)</span>
              </label>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-secondary" onClick={() => setRestoreTarget(null)}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={!restoreOpts.conversation && !restoreOpts.memory && !restoreOpts.code}
                onClick={() => restoreSnapshot(restoreTarget, restoreOpts)}
              >Restore</button>
            </div>
          </div>
        </div>
      )}

      {showUsage && (        <div className="modal-overlay" onClick={() => setShowUsage(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 620, maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 className="modal-title" style={{ margin: 0 }}>
                <BarChart2 size={16} style={{ marginRight: 8, verticalAlign: 'text-bottom' }} />
                Usage Stats
              </h3>
              <div style={{ display: 'flex', gap: 6 }}>
                {[7, 14, 30, 90].map(d => (
                  <button
                    key={d}
                    className={`btn btn-sm ${usageDays === d ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => { setUsageDays(d); loadUsageStats(d); }}
                  >{d}d</button>
                ))}
              </div>
            </div>

            {/* Totals row */}
            {usageTotals && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10, marginBottom: 20 }}>
                {[
                  { label: 'Total Tokens', value: ((usageTotals.input_tokens + usageTotals.output_tokens) / 1000).toFixed(1) + 'K' },
                  { label: 'Efficiency', value: 'Auto-optimized' },
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

            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: -6, marginBottom: 18, textAlign: 'center' }}>
              SUNy optimizes prompt caching and token reuse automatically in the background.
            </div>

            {/* Daily bar chart (pure CSS) */}
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
                        <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }} title={`${d.day}: ${total.toLocaleString()} tokens`}>
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

            {/* By mode breakdown */}
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
                          <span style={{ color: 'var(--text-muted)' }}>{(total / 1000).toFixed(1)}K � ${m.charged_cost.toFixed(4)}</span>
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

            {/* By project breakdown */}
            {usageByProject.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>By Project</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {usageByProject.map(p => {
                    const total = p.input_tokens + p.output_tokens;
                    const maxTotal = Math.max(...usageByProject.map(x => x.input_tokens + x.output_tokens), 1);
                    const pct = Math.round((total / maxTotal) * 100);
                    return (
                      <div key={`${p.project_id ?? 'global'}-${p.project_name}`}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, marginBottom: 4 }}>
                          <span style={{ color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.project_name}</span>
                          <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{(total / 1000).toFixed(1)}K � ${p.charged_cost.toFixed(4)}</span>
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

            {usageByDay.length === 0 && usageByMode.length === 0 && usageByProject.length === 0 && (
              <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '24px 0' }}>
                No usage data yet. Start chatting to see stats here!
              </p>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn btn-primary" onClick={() => setShowUsage(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Onboarding Modal */}
      {showOnboarding && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div style={{ textAlign: 'center', padding: '8px 0 16px' }}>
              <img src="/SLOGO.png" alt="SUNy" style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover', marginBottom: 10, boxShadow: '0 4px 16px rgba(108,99,255,0.3)' }} />
              <h2 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 700 }}>Welcome to SUNy!</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6, margin: '0 0 20px' }}>
                Your personal AI assistant � ask anything, build anything. Here's how to start:
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
              {[
                { icon: '📁', title: 'Create or open a project', desc: 'Click "+ New" in the sidebar to link a folder on your computer or let SUNy create one from scratch.' },
                { icon: '💬', title: 'Just talk to SUNy', desc: 'Ask questions, get explanations, request changes. SUNy understands what you want and gets it done.' },
                { icon: '⚡', title: 'Connect the Bridge for full power', desc: 'The Bridge lets SUNy actually write files and run commands on your machine � one terminal command to set up.' },
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
              <button className="btn btn-primary" style={{ padding: '9px 24px' }} onClick={dismissOnboarding}>
                Get Started ?
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Help / Shortcuts Modal */}
      {showHelp && (
        <div className="modal-overlay" onClick={() => setShowHelp(false)}>
          <div className="modal" style={{ maxWidth: 540, maxHeight: '80vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 className="modal-title" style={{ margin: 0 }}>
                <HelpCircle size={16} style={{ marginRight: 8, verticalAlign: 'text-bottom' }} />
                Help & Shortcuts
              </h3>
              <button className="btn btn-icon btn-secondary" onClick={() => setShowHelp(false)}><X size={14} /><Check size={12} /><X size={12} /></button>
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
                    { icon: <Rocket size={16} />, title: 'One-Click Ship', desc: 'Give one goal — SUNy plans, edits, tests, fixes, and delivers a verified result.' },
                    { icon: <ShieldCheck size={16} />, title: 'Proof Panel', desc: 'Every task shows exactly what changed, what passed, and what was fixed.' },
                    { icon: <Undo size={16} />, title: 'One-Click Undo', desc: 'Every edit creates a restore point. Roll back any change instantly.' },
                    { icon: <Brain size={16} />, title: 'Code Conscience', desc: 'Design memory remembers your intent across sessions and alerts on drift.' },
                    { icon: <MessageSquare size={16} />, title: 'Talk / Write mode', desc: 'Toggle between conversational chat and file-focused code editing.' },
                    { icon: <BookOpen size={16} />, title: 'Project Rules', desc: 'Set persistent instructions SUNy follows in every chat for a project.' },
                    { icon: <User size={16} />, title: 'Persona', desc: 'Give SUNy a custom role — e.g. "You are a security expert".' },
                    { icon: <CheckCircle size={16} />, title: 'Auto-Verify', desc: 'SUNy runs tests and lint in a loop until all errors are resolved.' },
                    { icon: <FileText size={16} />, title: '@file mentions', desc: 'Type @file:path in any message to reference a file directly.' },
                    { icon: <Play size={16} />, title: 'Dev Server', desc: 'Start your dev server from the sidebar and get a clickable URL.' },
                    { icon: <Lock size={16} />, title: 'Secure Bridge', desc: 'Sandboxed bridge connection for safe file operations.' },
                    { icon: <Eye size={16} />, title: 'Symbol Reader', desc: 'Inspect file structure without reading the whole file content.' },
                    { icon: <Globe size={16} />, title: 'URL Fetch', desc: 'SUNy can fetch web pages and docs on demand during tasks.' },
                    { icon: <Wrench size={16} />, title: 'Auto-Correction', desc: 'Failed code is analyzed and fixed automatically.' },
                    { icon: <Users size={16} />, title: 'Subtask Delegation', desc: 'Complex tasks are split into focused sub-tasks with dedicated agents.' },
                  ].map(f => (
                    <div key={f.title} style={{ display: 'flex', gap: 10 }}>
                      <span style={{ fontSize: 16, flexShrink: 0 }}>{f.icon}</span>
                      <div>
                        <span style={{ fontWeight: 600, fontSize: 12 }}>{f.title}</span>
                        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}> � {f.desc}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn btn-primary" onClick={() => setShowHelp(false)}>Got it</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
