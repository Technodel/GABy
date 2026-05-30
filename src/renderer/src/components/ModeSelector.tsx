interface Mode {
  mode: string;
  display_name: string;
  description?: string;
  session_limit_label: string;
  has_active_key?: boolean;
}

interface ModeSelectorProps {
  modes: Mode[];
  selected: string;
  onChange: (mode: string) => void;
  noBalance?: boolean;
}

// Shows only friendly labels (⚡ Free Mode, 🚀 Fast Mode, 🧠 Pro Mode)
// Never shows model names, providers, or technical info
export default function ModeSelector({ modes, selected, onChange, noBalance = false }: ModeSelectorProps) {
  return (
    <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', minWidth: 0 }}>
      {/* 4 AI modes pills aligned to the left */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
        {modes.filter(m => m.mode !== 'opus').map(m => {
          const isFreeLike = ['free', 'starter'].includes(m.mode.toLowerCase()) || /free|starter/i.test(m.display_name);
          const displayName = isFreeLike ? '⚡ Free' : m.display_name;
          const noKey = m.has_active_key === false;
          const lockedByBalance = noBalance && !isFreeLike;
          const disabled = noKey || lockedByBalance;
          const title = noKey
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
                padding: '4px 12px',
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 500,
                border: `1px solid ${disabled ? (lockedByBalance ? 'rgba(255,107,107,0.45)' : 'var(--border)') : m.mode === selected ? 'var(--accent)' : 'var(--border)'}`,
                background: disabled ? (lockedByBalance ? 'rgba(255,107,107,0.10)' : 'transparent') : m.mode === selected ? 'rgba(108,99,255,0.15)' : 'var(--surface)',
                color: disabled ? (lockedByBalance ? 'rgba(255,107,107,0.95)' : 'var(--text-muted)') : m.mode === selected ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled && !lockedByBalance ? 0.45 : 1,
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

      {/* OPUS 4.7 pill aligned to the right */}
      <button
        onClick={() => onChange('opus')}
        title="Claude Opus 4.7 - Complicated high level coding (0 Extra fees)"
        style={{
          padding: '2px 14px',
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 700,
          border: `1px solid ${selected === 'opus' ? '#a855f7' : 'var(--border)'}`,
          background: selected === 'opus' ? 'rgba(168,85,247,0.15)' : 'var(--surface)',
          color: selected === 'opus' ? '#a855f7' : 'var(--text-secondary)',
          cursor: 'pointer',
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
        <span>OPUS 4.7</span>
        <span style={{ fontSize: 9, fontWeight: 500, opacity: 0.8 }}>0 Extra fees</span>
      </button>
    </div>
  );
}
