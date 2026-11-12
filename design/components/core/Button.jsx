import React from 'react';

const H = { lg: 'var(--button-h-lg)', md: 'var(--button-h-md)', sm: 'var(--button-h-sm)' };
const PAD = { lg: '0 32px', md: '0 22px', sm: '0 16px' };
const FONT = { lg: 'var(--type-button)', md: '600 16px/22px var(--font-ui)', sm: 'var(--type-label)' };

export function Button({ children, variant = 'primary', size = 'lg', full = false, disabled = false, icon, onClick, style }) {
  const [down, setDown] = React.useState(false);
  const v = {
    primary: { background: down ? 'var(--action-pressed)' : 'var(--action)', color: 'var(--text-on-action)' },
    secondary: { background: down ? 'var(--surface-pressed)' : 'var(--surface-card)', color: 'var(--text-primary)' },
    ghost: { background: down ? 'var(--surface-card)' : 'transparent', color: 'var(--text-primary)' },
  }[variant];
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      onPointerDown={() => setDown(true)} onPointerUp={() => setDown(false)} onPointerLeave={() => setDown(false)}
      style={{
        appearance: 'none', border: 0, cursor: disabled ? 'default' : 'pointer', borderRadius: 'var(--radius-pill)',
        height: H[size], padding: PAD[size], font: FONT[size], width: full ? '100%' : 'auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        transform: down && !disabled ? 'scale(0.97)' : 'none', transition: 'transform var(--dur-fast) var(--ease-out), background var(--dur-fast)',
        opacity: disabled ? 0.32 : 1, ...v, ...style,
      }}>
      {icon}{children}
    </button>
  );
}
