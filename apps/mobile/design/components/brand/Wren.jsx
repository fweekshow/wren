import React from 'react';

// The official Wren art (assets/wren.png). Only the standing pose exists so far; other poses fall back to it.
const SCRIPT = typeof document !== 'undefined' && document.currentScript && document.currentScript.src;
const DEFAULT_BASE = SCRIPT ? new URL('assets/', SCRIPT).href : 'assets/';
const ART = { perch: 'wren.png', point: 'wren.png', carry: 'wren.png', cheer: 'wren.png' };

export function Wren({ pose = 'perch', size = 160, src, flip = false, style, title = 'Wren' }) {
  const base = (typeof window !== 'undefined' && window.WREN_ASSETS) || DEFAULT_BASE;
  return (
    <img src={src || base + (ART[pose] || ART.perch)} alt={title} width={size} height={Math.round(size * 537 / 640)}
      draggable={false} style={{ display: 'block', userSelect: 'none', transform: flip ? 'scaleX(-1)' : 'none', ...style }} />
  );
}
