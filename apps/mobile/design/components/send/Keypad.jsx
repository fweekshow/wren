import React from 'react';
import { Icon } from '../core/Icon.jsx';

const KEYS = ['1','2','3','4','5','6','7','8','9','.','0','del'];

function Key({ k, onKey, h }) {
  const [down, setDown] = React.useState(false);
  return (
    <button type="button" onClick={() => onKey && onKey(k)}
      onPointerDown={() => setDown(true)} onPointerUp={() => setDown(false)} onPointerLeave={() => setDown(false)}
      aria-label={k === 'del' ? 'Delete' : k}
      style={{
        appearance: 'none', border: 0, cursor: 'pointer', height: h, borderRadius: 'var(--radius-pill)',
        background: down ? 'var(--surface-card)' : 'transparent', color: 'var(--text-primary)', font: 'var(--type-key)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background var(--dur-fast)',
      }}>{k === 'del' ? <Icon name="delete" size={26} /> : k}</button>
  );
}

export function Keypad({ onKey, keyHeight = 56, style }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '2px 8px', ...style }}>
      {KEYS.map(k => <Key key={k} k={k} onKey={onKey} h={keyHeight} />)}
    </div>
  );
}

export function applyKey(current, k) {
  let s = String(current ?? '');
  if (k === 'del') return s.slice(0, -1);
  if (k === '.') return s.includes('.') ? s : (s || '0') + '.';
  if (s.includes('.') && s.split('.')[1].length >= 2) return s;
  if (s === '0') s = '';
  if (s.replace('.', '').length >= 6) return s;
  return s + k;
}
