'use client';
import { useEffect } from 'react';

/**
 * On mount, read `window.location.hash` — if it matches `#turn-<id>`,
 * scroll that element into view and apply a brief ring highlight so
 * users landing from `/search?...#turn-<id>` see where they ended up.
 *
 * Kept as a tiny leaf Client Component so the rest of TranscriptViewer
 * stays server-rendered.
 */
export function TurnScrollTo() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    if (!hash.startsWith('#turn-')) return;
    const el = document.getElementById(hash.slice(1));
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const ringClasses = [
      'ring-2',
      'ring-amber-400',
      'ring-offset-2',
      'ring-offset-neutral-50',
      'dark:ring-offset-neutral-950',
    ];
    el.classList.add(...ringClasses);
    const timer = window.setTimeout(() => {
      el.classList.remove(...ringClasses);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, []);
  return null;
}
