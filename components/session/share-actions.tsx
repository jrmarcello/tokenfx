'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';

type CopyStatus = 'idle' | 'copied' | 'error';

export function ShareActions({ sessionId }: { sessionId: string }) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');

  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/share`;

  const onCopy = async () => {
    try {
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setCopyStatus('copied');
      window.setTimeout(() => setCopyStatus('idle'), 2000);
    } catch {
      setCopyStatus('error');
      window.setTimeout(() => setCopyStatus('idle'), 3000);
    }
  };

  const onPrint = () => {
    window.print();
  };

  const baseBtn =
    'text-xs px-2.5 py-1 rounded border border-neutral-700 hover:border-neutral-500 text-neutral-300 transition';

  return (
    <div
      className="share-actions flex items-center gap-2 print:hidden"
      aria-label="Compartilhar"
    >
      <button
        type="button"
        aria-label="Copiar markdown"
        onClick={onCopy}
        className={cn(
          baseBtn,
          copyStatus === 'copied' &&
            'border-emerald-500 text-emerald-300 bg-emerald-950/40',
          copyStatus === 'error' &&
            'border-red-500 text-red-300 bg-red-950/40',
        )}
      >
        {copyStatus === 'copied'
          ? 'Copiado!'
          : copyStatus === 'error'
            ? 'Falha ao copiar'
            : 'Copiar markdown'}
      </button>
      <a
        aria-label="Baixar markdown"
        href={`${endpoint}?download=1`}
        download
        className={baseBtn}
      >
        Baixar .md
      </a>
      <button
        type="button"
        aria-label="Imprimir como PDF"
        onClick={onPrint}
        className={baseBtn}
      >
        Imprimir (PDF)
      </button>
    </div>
  );
}
