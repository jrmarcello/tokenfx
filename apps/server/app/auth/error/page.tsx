/**
 * NextAuth error landing page (REQ-3 of `.specs/sso-replay-audit-row.md`).
 *
 * NextAuth redirects browsers here on OAuth callback failures via
 * `auth.config.ts:pages.error: '/auth/error'`. This page is purely
 * presentational: it does NOT detect or persist anything. The
 * `auth_event_log` write for state-replay attempts is handled by
 * `auth.ts:writeReplayAuditRowOnInvalidCheck` (NextAuth's
 * `logger.error` hook) which runs synchronously inside the failed
 * callback's promise chain.
 *
 * Privacy invariants:
 *   - The raw `?error=<code>` value is NEVER echoed into the rendered
 *     DOM. A static map maps known codes to localized messages; unknown
 *     codes fall back to a generic string.
 *   - No request headers, cookies, or `state` cookie value are read or
 *     rendered.
 */
import Link from 'next/link';

type ErrorCode =
  | 'OAuthCallbackError'
  | 'Configuration'
  | 'Verification'
  | 'AccessDenied'
  | 'Default';

const ERROR_MESSAGE_MAP: Readonly<Record<ErrorCode, string>> = {
  OAuthCallbackError: 'Não foi possível concluir o login com o provedor.',
  Configuration: 'Erro de configuração na autenticação.',
  Verification: 'Não foi possível verificar a tentativa de login.',
  AccessDenied: 'Acesso negado.',
  Default: 'Erro ao autenticar.',
};

const ERROR_FALLBACK = 'Erro ao autenticar. Tente novamente.';

const isKnownErrorCode = (code: string): code is ErrorCode =>
  code in ERROR_MESSAGE_MAP;

export const lookupErrorMessage = (code: string | undefined): string => {
  if (!code) return ERROR_FALLBACK;
  return isKnownErrorCode(code) ? ERROR_MESSAGE_MAP[code] : ERROR_FALLBACK;
};

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const message = lookupErrorMessage(params.error);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-4">
      <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
        Falha de autenticação
      </h1>
      <p className="text-center text-sm text-neutral-700 dark:text-neutral-300">
        {message}
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
