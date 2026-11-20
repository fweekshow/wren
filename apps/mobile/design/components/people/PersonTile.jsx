import React from 'react';
import { Avatar } from './Avatar.jsx';

export function PersonTile({ name, hasWren = false, selected = false, onClick, size = 72 }) {
  return (
    <button type="button" onClick={onClick} style={{
      appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', padding: '8px 0',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, minWidth: 0,
    }}>
      <div style={{ borderRadius: '50%', padding: 3, boxShadow: selected ? 'inset 0 0 0 2.5px var(--people)' : 'none', transition: 'box-shadow var(--dur-fast)' }}>
        <Avatar name={name} size={size} />
      </div>
      <div style={{ font: 'var(--type-body)', color: 'var(--text-primary)' }}>{name}</div>
      <div style={{ height: 16, display: 'flex', alignItems: 'center', gap: 5, font: 'var(--type-caption)', color: 'var(--text-secondary)', marginTop: -6 }}>
        {hasWren && <><span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--people)' }} />Has Wren</>}
      </div>
    </button>
  );
}
