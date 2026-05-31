interface Mode {
  mode: string;
  display_name: string;
  description?: string;
  session_limit_label: string;
  has_active_key?: boolean;
  savings_pct?: number | null;
}

interface ModeSelectorProps {
  modes: Mode[];
  selected: string;
  onChange: (mode: string) => void;
  noBalance?: boolean;
  disabledOverall?: boolean;
}

// Shows only friendly labels (⚡ Free Mode, 🚀 Fast Mode, 🧠 Pro Mode)
// Never shows model names, providers, or technical info
export default function ModeSelector({ modes, selected, onChange, noBalance = false, disabledOverall = false }: ModeSelectorProps) {
  const opusMode = modes.find(m => m.mode === 'opus');

  return (
    <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', minWidth: 0 }}>
      {/* 4 AI modes pills aligned to the left */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
        {modes.filter(m => m.mode !== 'opus').map(m => {
          const isFreeLike = ['free', 'starter'].includes(m.mode.toLowerCase()) || /free|starter/i.test(m.display_name);
          const displayName = isFreeLike ? '⚡ Free' : m.display_name;
          const noKey = m.has_active_key === false;
          const lockedByBalance = noBalance && !isFreeLike;
          const disabled = noKey || lockedByBalance || disabledOverall;
          const title = disabledOverall
            ? 'Cannot change mode while SUNy is working. Cancel the task first.'
            : noKey
            ? 'No active API key for this mode — ask your admin to add one'
            : lockedByBalance
              ? 'Credits exhausted — top up to use this mode'
              : (m.description || m.session_limit_label);
          return (
            <button
              key={m.mode}
              onClick={() => !disabled && onChange(m.mode)}
              title={title}
              disabled={disabled}
              style={{
                padding: '3px 12px',
                borderRadius: 999,
                fontSize: 12,
                fontWeight: selected === m.mode ? 700 : 500,
                border: `1px solid ${selected === m.mode ? 'var(--accent)' : 'var(--border)'}`,
                background: selected === m.mode ? 'rgba(108,99,255,0.1)' : 'var(--surface)',
                color: selected === m.mode ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.5 : 1,
                boxShadow: lockedByBalance ? '0 0 0 1px rgba(255,107,107,0.08), inset 0 0 0 1px rgba(255,107,107,0.06)' : 'none',
                transition: 'all 0.15s',
                fontFamily: 'inherit',
              }}
            >
              {displayName}{noKey ? ' 🔑' : lockedByBalance ? ' 🔒' : ''}
            </button>
          );
        })}
      </div>

      {/* OPUS 4.8 pill aligned to the right */}
      {opusMode && (
        <button
          onClick={() => !disabledOverall && onChange('opus')}
          title={disabledOverall ? 'Cannot change mode while SUNy is working. Cancel the task first.' : `Claude Opus 4.8 - ${opusMode.description}`}
          disabled={disabledOverall}
          style={{
            padding: '2px 14px',
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 700,
            border: `1px solid ${selected === 'opus' ? '#a855f7' : 'var(--border)'}`,
            background: selected === 'opus' ? 'rgba(168,85,247,0.15)' : 'var(--surface)',
            color: selected === 'opus' ? '#a855f7' : 'var(--text-secondary)',
            cursor: disabledOverall ? 'not-allowed' : 'pointer',
            opacity: disabledOverall ? 0.5 : 1,
            transition: 'all 0.15s',
            fontFamily: 'inherit',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            lineHeight: '1.2',
            marginLeft: 8,
            flexShrink: 0
          }}
        >
          <span>OPUS 4.8</span>
          {opusMode.savings_pct ? (
            <span style={{ fontSize: 9, fontWeight: 500, opacity: 0.8 }}>Up to {opusMode.savings_pct}% discount</span>
          ) : null}
        </button>
      )}
    </div>
  );
}
