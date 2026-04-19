'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { log } from '@/lib/logger';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    log.error('page error boundary caught', error);
  }, [error]);

  return (
    <section className="mx-auto max-w-2xl space-y-4 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">
        Algo deu errado ao carregar esta página
      </h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        O servidor devolveu um erro inesperado. Você pode tentar de novo ou
        voltar pra home.
      </p>
      <div className="flex items-center justify-center gap-3 pt-2">
        <button
          onClick={reset}
          className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 transition-colors hover:border-neutral-400 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:bg-neutral-800"
        >
          Tentar novamente
        </button>
        <Link
          href="/"
          className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
        >
          Voltar pra home
        </Link>
      </div>
    </section>
  );
}
