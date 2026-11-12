import React from 'react';

const usd = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const WREN_FEE = 2.99;
export function totalFor(amount, pay) {
  const a = Number(amount) || 0;
  const card = pay === 'card' ? Math.round(a * 0.01 * 100) / 100 : 0;
  return { amount: a, fee: WREN_FEE, card, total: a + WREN_FEE + card };
}

export function FeeLine({ amount, pay = 'applepay', style }) {
  const t = totalFor(amount, pay);
  return (
    <div style={{ textAlign: 'center', font: 'var(--type-caption)', color: 'var(--text-secondary)', ...style }}>
      <span style={{ color: 'var(--text-primary)' }}>Total <span style={{ font: 'var(--type-ticker)' }}>{usd(t.total)}</span></span>
      {' · includes '}{usd(t.fee)} Wren{pay === 'card' && <> + {usd(t.card)} card (1%)</>}
    </div>
  );
}
