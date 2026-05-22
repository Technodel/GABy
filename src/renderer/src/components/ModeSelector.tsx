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
    <div style={{ display: 'flex', gap: 6 }}>
      {modes.map(m => {
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
  );
}
