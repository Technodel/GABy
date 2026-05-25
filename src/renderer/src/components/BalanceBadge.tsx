import { useState, useEffect, useRef } from 'react';
import { CreditCard, Wallet } from 'lucide-react';

interface BalanceBadgeProps {
  balance: number;
  walletBalance: number;
  remainingTokens?: number | null;
  onOpenWalletSettings?: () => void;
}

/**
 * Format a dollar amount with cents-granularity.
 * Shows 4 decimal places for small amounts (e.g., $0.0042), 2 for larger ones.
 */
function formatCents(amount: number): string {
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return `¢${(amount * 100).toFixed(2)}`;  // Show as cents when < 1¢
  if (amount < 1) return `$${amount.toFixed(4)}`;  // 4 decimal places for sub-dollar
  if (amount < 10) return `$${amount.toFixed(3)}`;  // 3 for single digits
  return `$${amount.toFixed(2)}`;  // 2 for larger amounts
}

// Shows balances in cents-granularity — no breakdown, no token counts
export default function BalanceBadge({ balance, walletBalance, remainingTokens = null, onOpenWalletSettings }: BalanceBadgeProps) {
  const prevWallet = useRef<number | null>(null);
  const prevBalance = useRef<number | null>(null);
  const [walletFlash, setWalletFlash] = useState<'down' | 'up' | null>(null);
  const [balanceFlash, setBalanceFlash] = useState<'down' | 'up' | null>(null);
  const [walletDelta, setWalletDelta] = useState<number | null>(null);
  const [balanceDelta, setBalanceDelta] = useState<number | null>(null);

  useEffect(() => {
    if (prevWallet.current === null) { prevWallet.current = walletBalance; return; }
    const delta = walletBalance - prevWallet.current;
    if (delta !== 0) {
      setWalletDelta(delta);
      setWalletFlash(delta < 0 ? 'down' : 'up');
      setTimeout(() => { setWalletFlash(null); setWalletDelta(null); }, 2000);
    }
    prevWallet.current = walletBalance;
  }, [walletBalance]);

  useEffect(() => {
    if (prevBalance.current === null) { prevBalance.current = balance; return; }
    const delta = balance - prevBalance.current;
    if (delta !== 0) {
      setBalanceDelta(delta);
      setBalanceFlash(delta < 0 ? 'down' : 'up');
      setTimeout(() => { setBalanceFlash(null); setBalanceDelta(null); }, 2000);
    }
    prevBalance.current = balance;
  }, [balance]);

  const walletLow = walletBalance > 0 && walletBalance < 0.05;  // < 5¢ warning threshold
  const walletEmpty = walletBalance <= 0;
  const bothEmpty = balance <= 0 && walletBalance <= 0;
  const walletFormatted = formatCents(walletBalance);
  const balanceFormatted = formatCents(balance);

  const pillStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    borderRadius: 999,
    background: bothEmpty ? 'rgba(255,107,107,0.14)' : 'rgba(34,197,94,0.14)',
    border: bothEmpty ? '1px solid var(--error)' : '1px solid var(--success)',
    fontSize: 14,
    fontWeight: 700,
    color: bothEmpty ? 'var(--error)' : 'var(--success)',
    transition: 'background 0.3s, color 0.3s, border-color 0.3s',
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap' }}>
      {/* Wallet (bot fuel tank) */}
      <div 
        onClick={onOpenWalletSettings}
        style={{
          ...pillStyle,
          cursor: 'pointer',
          padding: '4px 10px',
          outline: walletFlash ? `2px solid ${walletFlash === 'down' ? 'var(--error, #ef4444)' : 'var(--success, #22c55e)'}` : 'none',
        }} 
        title="Bot Wallet — click to transfer funds from Main Balance"
      >
        <Wallet size={14} />
        <span>{walletFormatted}</span>
        {walletDelta !== null && (
          <span style={{ fontSize: 11, color: walletDelta < 0 ? 'var(--error, #ef4444)' : 'var(--success, #22c55e)', marginLeft: 2 }}>
            {walletDelta < 0 ? `−${formatCents(-walletDelta)}` : `+${formatCents(walletDelta)}`}
          </span>
        )}
      </div>

      {remainingTokens != null && (
        <div style={{ ...pillStyle, padding: '4px 10px' }} title="Remaining token budget for this session">
          <span style={{ opacity: 0.7, fontSize: 12 }}>Tokens</span>
          <span>{remainingTokens >= 1000 ? (remainingTokens/1000).toFixed(0)+'k' : remainingTokens}</span>
        </div>
      )}
    </div>
  );
}
