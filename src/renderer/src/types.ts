import type { ReportMetrics } from './components/ReportBadgeButton';

export interface Project {
  id: number;
  name: string;
  local_path: string;
  persona?: string | null;
  auto_execute_override?: boolean | null;
  default_tier?: 'free' | 'fast' | 'pro' | 'auto' | null;
}

export interface ProjectSpend {
  project_id: number;
  name: string;
  total_tokens: number;
  total_cost: number;
}

export interface Mode {
  mode: string;
  display_name: string;
  session_limit_label: string;
}

export interface UserData {
  id: number;
  username: string;
  balance: number;
  wallet_balance: number;
  wallet_auto_spend: boolean;
  auto_approve?: boolean;
  selected_mode: string;
  max_tokens_per_session?: number | null;
  cross_device_memory_enabled?: boolean;
  chat_show_technical_details?: boolean;
  bridge_connected: boolean;
  bridge_previously_connected?: boolean;
  modes: Mode[];
}

export interface Message {
  type: 'user' | 'suny' | 'system';
  content: string;
  id: number;
  timestamp: number;
  report?: ReportMetrics;
}

export interface Memory {
  id: string;
  projectId: number;
  title: string;
  summary: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProofRun {
  id: number;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'completed' | 'failed';
  toolCalls: string[];
  checks: string[];
  durationMs?: number;
  toolCallCount?: number;
  filesChanged?: number;
  steps?: number;
}

export interface ChatProps {
  onLogout: () => void;
  onOpenSettings: (section?: 'general' | 'wallet', notice?: string) => void;
  onBridgeOffline: () => void;
}

export interface FileNode {
  name: string; path: string; isDir: boolean; children?: FileNode[];
}

export interface CheckpointEntry {
  sha: string; message: string; date: string; filesChanged?: number;
}

export interface BlueprintEntry {
  id: number; category: string; summary: string; intent: string | null;
  affected_files: string | null; created_at: string;
}

export interface UsageDay {
  day: string; input_tokens: number; output_tokens: number; charged_cost: number;
}

export interface UsageMode {
  mode: string; input_tokens: number; output_tokens: number; charged_cost: number;
}

export interface UsageTotals {
  input_tokens: number; output_tokens: number; charged_cost: number;
}
