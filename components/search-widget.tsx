'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * Global header search input. Submits to `/search?q=X` (existing page handles
 * pagination/filters). Keyboard shortcut `/` focuses from anywhere (GitHub /
 * Linear convention), `Esc` blurs. Mobile (<sm) collapses to just a lupa
 * trigger that expands the input.
 */
export function SearchWidget() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [expandedMobile, setExpandedMobile] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/') return;
      const a = document.activeElement;
      if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) return;
      if (
        a &&
        'isContentEditable' in a &&
        (a as HTMLElement).isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      setExpandedMobile(true);
      // Defer focus to next tick so the input is mounted when expanded.
      queueMicrotask(() => inputRef.current?.focus());
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = q.trim();
    if (trimmed.length === 0) return;
    router.push(`/search?q=${encodeURIComponent(trimmed)}`);
  };

  const onKeyDownInput = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      inputRef.current?.blur();
      setExpandedMobile(false);
    }
  };

  return (
    <form
      role="search"
      onSubmit={onSubmit}
      className="flex items-center print:hidden"
    >
      {/* Mobile trigger (<sm) — only shown when not expanded */}
      {!expandedMobile && (
        <button
          type="button"
          aria-label="Abrir busca"
          onClick={() => {
            setExpandedMobile(true);
            queueMicrotask(() => inputRef.current?.focus());
          }}
          className="sm:hidden inline-flex size-8 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          <SearchGlyph className="size-4" />
        </button>
      )}
      <label
        className={cn(
          'relative items-center',
          expandedMobile ? 'flex' : 'hidden sm:flex',
        )}
      >
        <span className="sr-only">Buscar no transcript</span>
        <SearchGlyph
          aria-hidden
          className="pointer-events-none absolute left-2 size-3.5 text-neutral-400 dark:text-neutral-500"
        />
        <input
          ref={inputRef}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDownInput}
          aria-label="Buscar no transcript"
          placeholder="Buscar no transcript…"
          maxLength={200}
          className="w-64 rounded-md border border-neutral-200 bg-white pl-7 pr-2 py-1 text-sm text-neutral-900 placeholder:text-neutral-400 outline-none focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-600"
        />
      </label>
    </form>
  );
}

function SearchGlyph(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
