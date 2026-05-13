'use client';

import Link from 'next/link';

/**
 * Route segment error boundary for `/auth/error`. Belt-and-suspenders:
 * the page itself is purely presentational (no DB calls, no side
 * effects — those live in `auth.ts:writeReplayAuditRowOnInvalidCheck`),
 * so reaching this boundary indicates an unexpected render failure.
 * We still render a usable fallback rather than the framework's
 * default crash page.
 */
export default function AuthErrorBoundary() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-4">
      <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
        Falha de autenticação
      </h1>
      <p className="text-center text-sm text-neutral-700 dark:text-neutral-300">
        Erro ao autenticar. Tente novamente.
      </p>
      <Link
        href="/api/auth/signin"
        className="inline-flex h-9 items-center justify-center rounded-md border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-900 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
      >
        Voltar ao login
      </Link>
    </main>
  );
}
