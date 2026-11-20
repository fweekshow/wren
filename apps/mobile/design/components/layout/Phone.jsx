import React from 'react';

export function Phone({ children, label, style }) {
  return (
    <div data-screen-label={label} style={{
      width: 'var(--screen-w)', height: 'var(--screen-h)', position: 'relative', overflow: 'hidden', flex: 'none',
      background: 'var(--surface-canvas)', borderRadius: 48, boxShadow: '0 0 0 1px var(--border-hairline)', ...style,
    }}>
      <div style={{ height: 'var(--status-h)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 32px 0 40px', font: '600 17px/1 var(--font-ui)', color: 'var(--text-primary)' }}>
        <span>9:41</span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ width: 18, height: 11, display: 'flex', gap: 2, alignItems: 'flex-end' }}>{[4, 6, 8, 11].map(h => <i key={h} style={{ width: 3, height: h, background: 'currentColor', borderRadius: 1 }} />)}</span>
          <span style={{ width: 25, height: 12, border: '1.5px solid currentColor', borderRadius: 4, padding: 1.5, opacity: 0.9 }}><i style={{ display: 'block', width: '80%', height: '100%', background: 'currentColor', borderRadius: 1.5 }} /></span>
        </span>
      </div>
      <div style={{ position: 'absolute', inset: 'var(--status-h) 0 0 0', display: 'flex', flexDirection: 'column' }}>{children}</div>
      <div style={{ position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)', width: 134, height: 5, borderRadius: 3, background: 'var(--text-primary)' }} />
    </div>
  );
}

export function PinnedAction({ children }) {
  return <div style={{ position: 'absolute', left: 24, right: 24, bottom: 'var(--home-indicator)' }}>{children}</div>;
}
