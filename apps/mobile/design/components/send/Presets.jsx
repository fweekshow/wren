import React from 'react';

export function Presets({ options = [25, 50, 100], value, onChange, style }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'center', ...style }}>
      {options.map(o => {
        const on = Number(value) === o;
        return (
          <button key={o} type="button" onClick={() => onChange && onChange(o)} style={{
            appearance: 'none', cursor: 'pointer', height: 40, minWidth: 76, padding: '0 16px', borderRadius: 'var(--radius-pill)',
            border: 0, background: on ? 'var(--text-primary)' : 'var(--surface-card)', color: on ? 'var(--white)' : 'var(--text-primary)',
            font: '600 16px/1 var(--font-ui)',
          }}>${o}</button>
        );
      })}
    </div>
  );
}
