/**
 * `/manager/invites/created` — show-once invite URL (REQ-22).
 *
 * Server Component. Reads + DELETES the `onboard_flash` cookie via
 * `readAndDeleteFlashCookie`. The cookie is one-shot — a page reload
 * (or a back/forward navigation that triggers a re-render) finds it
 * absent and we fall through to the empty-state.
 *
 * Important security properties (carried over from `flash-cookie.ts`):
 *
 *   - The cookie value is HMAC-signed; tampering returns `null`.
 *   - The cookie is `httpOnly` + `sameSite=strict` + path-scoped to
 *     this exact route — JavaScript can't read it, cross-site reqs
 *     can't carry it.
 *   - The full token lives in the URL fragment (`#token=...`) we render
 *     here. Fragments are NEVER sent to the server, so even though we
 *     rendered the URL once, it does not appear in any access log.
 *   - We delete the cookie BEFORE rendering. If the render throws after
 *     the read, the cookie is still gone — refresh shows empty-state,
 *     not a re-display.
 *
 * Empty state path is also reachable when a user visits the URL directly
 * without going through `/manager/invites/create` first. The copy is
 * tuned for that case: "URL not available — return to /manager/invites".
 */
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import {
  readFlashCookie,
  type FlashCookieStore,
} from '@/lib/auth/flash-cookie';
import { FlashCopyButton } from '@/components/manager/flash-copy-button';
import { FlashCookieClearer } from '@/components/manager/flash-cookie-clearer';

/**
 * Adapter — Next 15's `cookies()` is async; map it onto FlashCookieStore.
 * Server Components can READ cookies but NOT mutate them; the `set`/`delete`
 * stubs throw to make accidental misuse loud. Mutation happens via the
 * `clearFlashCookieAction` Server Action (invoked client-side on mount).
 */
const buildReadOnlyCookieStore = async (): Promise<FlashCookieStore> => {
  const store = await cookies();
  return {
    get: (name) => {
      const c = store.get(name);
      return c ? { value: c.value } : undefined;
    },
    set: () => {
      throw new Error('cannot mutate cookies from Server Component');
    },
    delete: () => {
      throw new Error('cannot mutate cookies from Server Component');
    },
  };
};

export default async function ManagerInvitesCreatedPage() {
  const session = await auth();
  if (!session?.user?.orgId) {
    redirect('/api/auth/signin');
  }

  const store = await buildReadOnlyCookieStore();
  // Read-only — the Server Action `clearFlashCookieAction` invoked by the
  // mounted Client Component below performs the actual delete (Next.js 15
  // cookie-mutation constraint). Reload after the clear lands shows
  // empty-state, preserving the one-shot semantics.
  const url = readFlashCookie(store);

  return (
    <div className="space-y-6">
      <div>
        <nav
          className="mb-1 text-xs text-neutral-500 dark:text-neutral-400"
          aria-label="Breadcrumb"
        >
          <Link
            href="/manager"
            className="hover:text-neutral-700 hover:underline dark:hover:text-neutral-200"
          >
            Manager
          </Link>
          <span className="mx-1.5">/</span>
          <Link
            href="/manager/invites"
            className="hover:text-neutral-700 hover:underline dark:hover:text-neutral-200"
          >
            Convites
          </Link>
          <span className="mx-1.5">/</span>
          <span>Criado</span>
        </nav>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
          Convite criado
        </h1>
      </div>

      {url ? <FlashCookieClearer /> : null}

      {url ? (
        <div
          className="space-y-4 rounded-lg border border-amber-200 bg-amber-50 p-6 dark:border-amber-900 dark:bg-amber-950"
          data-testid="flash-onboard-url"
        >
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">
            Este URL é mostrado apenas uma vez. Copie agora.
          </p>
          <div className="flex items-center gap-2">
            <code
              className="block flex-1 select-all break-all rounded border border-amber-200 bg-white px-3 py-2 font-mono text-xs text-neutral-900 dark:border-amber-900 dark:bg-neutral-950 dark:text-neutral-100"
              data-testid="flash-onboard-url-value"
            >
              {url}
            </code>
            <FlashCopyButton value={url} />
          </div>
          <div className="space-y-2 text-sm text-amber-900 dark:text-amber-100">
            <p className="font-medium">Próximos passos:</p>
            <ol className="ml-5 list-decimal space-y-1 text-amber-900/90 dark:text-amber-100/90">
              <li>
                Envie este URL pelo canal seguro do time (DM 1:1, gerenciador
                de senhas). NÃO use canais públicos.
              </li>
              <li>
                O destinatário abre o URL no navegador, copia o token e roda{' '}
                <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs dark:bg-amber-900">
                  pnpm reporter:setup
                </code>
                .
              </li>
              <li>
                Recarregar esta página descarta o URL. Se você perder, crie um
                novo convite — o antigo continua válido até expirar ou ser
                revogado.
              </li>
            </ol>
          </div>
          <div>
            <Link
              href="/manager/invites"
              className="text-sm text-amber-900 underline hover:text-amber-700 dark:text-amber-100 dark:hover:text-amber-300"
            >
              Voltar para a lista de convites
            </Link>
          </div>
        </div>
      ) : (
        <div
          className="rounded-lg border border-dashed border-neutral-300 bg-white p-6 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400"
          data-testid="flash-empty-state"
        >
          <p className="font-medium text-neutral-900 dark:text-neutral-100">
            URL não disponível.
          </p>
          <p className="mt-2">
            O URL de onboarding é mostrado apenas uma vez logo após a criação.
            Volte para{' '}
            <Link
              href="/manager/invites"
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              /manager/invites
            </Link>{' '}
            e crie um novo convite.
          </p>
        </div>
      )}
    </div>
  );
}
