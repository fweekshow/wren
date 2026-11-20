import React from 'react';

// The Wren mark: a chat bird. This is the app icon and the logo.
const SCRIPT = typeof document !== 'undefined' && document.currentScript && document.currentScript.src;
const DEFAULT_BASE = SCRIPT ? new URL('assets/', SCRIPT).href : 'assets/';

export function Logo({ size = 96, src, style, title = 'Wren' }) {
  const base = (typeof window !== 'undefined' && window.WREN_ASSETS) || DEFAULT_BASE;
  return (
    <img src={src || base + 'logo.png'} alt={title} width={size} height={Math.round(size * 902 / 1024)}
      draggable={false} style={{ display: 'block', userSelect: 'none', ...style }} />
  );
}
