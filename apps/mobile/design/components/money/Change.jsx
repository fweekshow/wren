import React from 'react';

export function Change({ value, style }) {
  const up = value >= 0;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', height: 24, padding: '0 9px', borderRadius: 'var(--radius-pill)',
      background: up ? 'var(--move-up)' : 'var(--move-down)', color: 'var(--move-text)',
      font: 'var(--type-percent)', letterSpacing: 'var(--tracking-mono)', whiteSpace: 'nowrap', ...style,
    }}>{up ? '+' : '−'}{Math.abs(value).toFixed(2)}%</span>
  );
}
