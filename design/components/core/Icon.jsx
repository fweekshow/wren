import React from 'react';

// Lucide (lucide-static@0.460.0) inner markup, copied verbatim from assets/icons/*.svg
const ICONS = {
 "chevron-left": "<path d=\"m15 18-6-6 6-6\" />",
 "search": "<circle cx=\"11\" cy=\"11\" r=\"8\" /> <path d=\"m21 21-4.3-4.3\" />",
 "delete": "<path d=\"M10 5a2 2 0 0 0-1.344.519l-6.328 5.74a1 1 0 0 0 0 1.481l6.328 5.741A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z\" /> <path d=\"m12 9 6 6\" /> <path d=\"m18 9-6 6\" />",
 "credit-card": "<rect width=\"20\" height=\"14\" x=\"2\" y=\"5\" rx=\"2\" /> <line x1=\"2\" x2=\"22\" y1=\"10\" y2=\"10\" />",
 "x": "<path d=\"M18 6 6 18\" /> <path d=\"m6 6 12 12\" />",
 "check": "<path d=\"M20 6 9 17l-5-5\" />"
};

export function Icon({ name, size = 24, color = 'currentColor', strokeWidth = 2, style }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', flex: 'none', ...style }}
      dangerouslySetInnerHTML={{ __html: ICONS[name] || '' }} />
  );
}
