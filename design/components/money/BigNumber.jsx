import React from 'react';

export function BigNumber({ value, size = 'total', cents = true, color = 'var(--text-primary)', style }) {
  const n = Number(value) || 0;
  const [whole, frac] = n.toFixed(2).split('.');
  const w = Number(whole).toLocaleString('en-US');
  const font = size === 'amount' ? 'var(--type-amount)' : 'var(--type-total)';
  return (
    <div style={{ font, letterSpacing: 'var(--tracking-display)', color, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', fontVariantNumeric: 'tabular-nums', ...style }}>
      <span style={{ fontSize: '0.55em', lineHeight: 1, marginTop: '0.08em', marginRight: '0.02em' }}>$</span>
      <span>{w}</span>
      {cents && <span style={{ fontSize: '0.55em', lineHeight: 1, marginTop: '0.08em', marginLeft: '0.04em', color: 'var(--text-tertiary)' }}>.{frac}</span>}
    </div>
  );
}
