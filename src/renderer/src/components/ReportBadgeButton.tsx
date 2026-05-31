import { useEffect, useRef, useState } from 'react';
import { BarChart2 } from 'lucide-react';

export interface ReportMetrics {
  durationMs: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  chargedCost: number;
  rawCost?: number;
  humanEstimateMinutes: number;
  humanEstimateCost: number;
  messageCount?: number;
}

interface ReportBadgeButtonProps {
  report: ReportMetrics;
  label: string;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatMoney(amount: number): string {
  if (!isFinite(amount) || amount <= 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(amount < 1 ? 3 : 2)}`;
}

function formatTokens(tokens: number): string {
  if (!isFinite(tokens) || tokens < 0) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${Math.round(tokens)}`;
}

export default function ReportBadgeButton({ report, label }: ReportBadgeButtonProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={e => {
          e.stopPropagation();
          setOpen(v => !v);
        }}
        title={label}
        style={{
          width: 18,
          height: 18,
          borderRadius: 999,
          border: '1px solid rgba(108,99,255,0.25)',
          background: open ? 'rgba(108,99,255,0.18)' : 'rgba(255,255,255,0.03)',
          color: 'var(--accent)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
        }}
      >
        <BarChart2 size={11} />
      </button>

      {open && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: 'absolute',
            right: 0,
            bottom: 'calc(100% + 8px)',
            width: 230,
            zIndex: 9999,
            borderRadius: 10,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            boxShadow: '0 18px 42px rgba(0,0,0,0.28)',
            padding: '10px 12px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <strong style={{ fontSize: 12, color: 'var(--text-primary)' }}>{label}</strong>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{report.messageCount ? `${report.messageCount} run${report.messageCount === 1 ? '' : 's'}` : 'No report data'}</span>
          </div>

          <div style={rowStyle}>
            <span style={labelStyle}>Time spent</span>
            <span style={valueStyle}>{formatDuration(report.durationMs)}</span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Tokens spent</span>
            <span style={valueStyle}>{formatTokens(report.totalTokens)}</span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>$ spent</span>
            <span style={valueStyle}>
              {report.chargedCost === 0 ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  {(report.rawCost ?? 0) > 0 && (
                    <span style={{ textDecoration: 'line-through', opacity: 0.45, fontSize: 10 }}>{formatMoney(report.rawCost!)}</span>
                  )}
                  <span style={{ color: 'var(--success,#22c55e)' }}>Free</span>
                </span>
              ) : (
                formatMoney(report.chargedCost)
              )}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Human estimate</span>
            <span style={valueStyle}>{formatDuration(report.humanEstimateMinutes * 60_000)}</span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.45 }}>
            About {formatMoney(report.humanEstimateCost)} at a mid-range freelance rate.
          </div>

          {report.messageCount === 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.45 }}>
              Detailed turn reports will appear after SUNy finishes a task in this chat.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 10,
  fontSize: 11,
  lineHeight: 1.5,
  marginBottom: 4,
};

const labelStyle: React.CSSProperties = {
  color: 'var(--text-muted)',
};

const valueStyle: React.CSSProperties = {
  color: 'var(--text-primary)',
  fontWeight: 600,
  textAlign: 'right',
};