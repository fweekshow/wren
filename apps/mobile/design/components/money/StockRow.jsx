import React from 'react';
import { Change } from './Change.jsx';

export function StockRow({ name, ticker, value, change, onClick, last = false }) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', minHeight: 72,
      borderBottom: last ? 0 : '1px solid var(--border-hairline)', cursor: onClick ? 'pointer' : 'default',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ font: 'var(--type-body)', color: 'var(--text-primary)' }}>{name}</div>
        <div style={{ font: 'var(--type-ticker)', letterSpacing: 'var(--tracking-mono)', color: 'var(--text-secondary)', marginTop: 2 }}>{ticker}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <div style={{ font: 'var(--type-price)', color: 'var(--text-primary)' }}>${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        <Change value={change} />
      </div>
    </div>
  );
}

export function StockList({ children, style }) {
  return <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', overflow: 'hidden', ...style }}>{children}</div>;
}
