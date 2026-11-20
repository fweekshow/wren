import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function SearchField({ value, onChange, placeholder = 'Search', style }) {
  return (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 10, height: 48, padding: '0 18px', borderRadius: 'var(--radius-pill)',
      background: 'var(--surface-card)', color: 'var(--text-tertiary)', ...style,
    }}>
      <Icon name="search" size={20} />
      <input value={value} placeholder={placeholder} onChange={e => onChange && onChange(e.target.value)} style={{
        flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', font: 'var(--type-body-regular)', color: 'var(--text-primary)',
      }} />
    </label>
  );
}
