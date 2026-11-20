import React from 'react';

const TINTS = ['var(--people-face)', 'var(--people-face-2)'];

export function Avatar({ name = '', size = 64, style }) {
  const i = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length;
  return (
    <div aria-label={name} style={{
      width: size, height: size, borderRadius: 'var(--radius-face)', background: TINTS[i], color: 'var(--people-initial)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
      font: `500 ${Math.round(size * 0.4)}px/1 var(--font-display)`, letterSpacing: '-0.03em', ...style,
    }}>{name.slice(0, 1).toUpperCase()}</div>
  );
}
