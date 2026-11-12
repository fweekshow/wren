import React from 'react';

export function StockPicker({ stocks, value, onChange, style }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', ...style }}>
      {stocks.map(s => {
        const on = s.ticker === value;
        return (
          <button key={s.ticker} type="button" onClick={() => onChange && onChange(s.ticker)} style={{
            appearance: 'none', cursor: 'pointer', height: 36, padding: '0 14px', borderRadius: 'var(--radius-pill)',
            border: on ? '1.5px solid var(--text-primary)' : '1.5px solid transparent',
            background: on ? 'var(--surface-canvas)' : 'var(--surface-card)', color: 'var(--text-primary)',
            font: 'var(--type-label)', display: 'inline-flex', alignItems: 'center',
          }}>{s.name}</button>
        );
      })}
    </div>
  );
}
