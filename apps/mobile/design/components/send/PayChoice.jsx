import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function PayChoice({ value = 'applepay', onChange, style }) {
  const opt = (id, label, icon) => {
    const on = value === id;
    return (
      <button type="button" onClick={() => onChange && onChange(id)} style={{
        appearance: 'none', border: 0, cursor: 'pointer', flex: 1, height: 40, borderRadius: 'var(--radius-pill)',
        background: on ? (id === 'applepay' ? 'var(--text-primary)' : 'var(--surface-canvas)') : 'transparent',
        color: on && id === 'applepay' ? 'var(--white)' : 'var(--text-primary)',
        boxShadow: on && id !== 'applepay' ? 'inset 0 0 0 1.5px var(--text-primary)' : 'none',
        font: 'var(--type-label)', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        transition: 'background var(--dur-fast)',
      }}>{icon}{label}</button>
    );
  };
  return (
    <div role="radiogroup" style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 'var(--radius-pill)', background: 'var(--surface-card)', ...style }}>
      {opt('applepay', 'Apple Pay')}
      {opt('card', 'Card', <Icon name="credit-card" size={18} />)}
    </div>
  );
}
