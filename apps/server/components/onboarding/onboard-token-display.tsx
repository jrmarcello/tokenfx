'use client';

/**
 * Onboarding token display — REQ-17 leaf.
 *
 * Reads the invite token from `window.location.hash` (URL fragment is
 * client-only — never reaches the server, never appears in proxy/access
 * logs). Validates against the canonical 64-char hex shape produced by
 * `generateInviteToken()` (REQ-14). Renders a copy-to-clipboard UI plus
 * security guidance ("shown once, treat like a password, close tab").
 *
 * No DB, no auth, no server data flow — keep this leaf truly isolated.
 * Do NOT add imports from `lib/db/*` or `lib/auth/*`.
 *
 * Implementation note: the URL fragment is an external (browser) data
 * source, so we use `useSyncExternalStore` to subscribe to it. This is
 * the React-recommended way to consume browser APIs in a Client
 * Component (avoids the `react-hooks/set-state-in-effect` foot-gun that
 * `useEffect` + `setState` would trigger). The server snapshot is
 * always `null`, ensuring SSR (had we not been a `'use client'` leaf)
 * would render the empty state and hydrate cleanly.
 */
import { useState, useSyncExternalStore } from 'react';

const TOKEN_FRAGMENT_RE = /^#token=([0-9a-f]{64})$/;

const subscribeToHash = (onChange: () => void): (() => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};

const getHashSnapshot = (): string => window.location.hash;

const getHashServerSnapshot = (): string => '';

export const OnboardTokenDisplay = () => {
  const hash = useSyncExternalStore(
    subscribeToHash,
    getHashSnapshot,
    getHashServerSnapshot,
  );
  const match = TOKEN_FRAGMENT_RE.exec(hash);
  const token: string | null = match ? match[1] : null;

  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API can fail (insecure context, permissions). The token is
      // already selectable in the monospace box, so the user has a fallback.
      setCopied(false);
    }
  };

  if (!token) {
    return (
      <div
        className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
        data-testid="onboard-empty"
      >
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Onboarding
        </h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          Nenhum token na URL. Peça ao seu manager o link completo de onboarding.
        </p>
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      data-testid="onboard-token"
    >
      <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
        Token de Onboarding
      </h1>

      <div className="mt-4 flex items-center gap-2">
        <code
          className="block flex-1 select-all break-all rounded border border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          data-testid="onboard-token-value"
        >
          {token}
        </code>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md bg-neutral-900 px-4 text-sm font-medium text-neutral-50 shadow transition-colors hover:bg-neutral-900/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-950 disabled:pointer-events-none disabled:opacity-50 dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-neutral-50/90 dark:focus-visible:ring-neutral-300"
          data-testid="onboard-copy-button"
        >
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>

      <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
        <p>
          Este token é mostrado apenas uma vez. Trate como uma senha. Cole no terminal:{' '}
          <code className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs dark:bg-amber-900">
            pnpm reporter:setup
          </code>{' '}
          ou{' '}
          <code className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs dark:bg-amber-900">
            pnpm reporter:setup --token=&lt;paste&gt;
          </code>
          .
        </p>
      </div>

      <p className="mt-3 text-xs text-neutral-600 dark:text-neutral-400">
        Após copiar, feche esta aba para limpar o histórico do navegador.
      </p>
    </div>
  );
};
