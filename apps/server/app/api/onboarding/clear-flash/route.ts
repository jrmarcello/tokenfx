/**
 * POST /api/onboarding/clear-flash — invalidate the show-once flash cookie.
 *
 * Why a Route Handler (not a Server Action): Next.js 15 forbids
 * `cookies().delete()` from Server Components, but ANY Server Action
 * invocation triggers an automatic RSC payload re-fetch of the current
 * route. That re-render reads the now-empty cookie and falls through to
 * the empty state — the user sees the URL flicker and disappear before
 * they can copy it. A Route Handler delete leaves the rendered page
 * untouched (no revalidation), preserving the show-once display until
 * the user navigates away.
 *
 * Auth: none. The cookie is HMAC-signed and path-scoped to
 * `/manager/invites/created`; clearing it is harmless to anyone (worst
 * case: the user loses their own URL display).
 *
 * Idempotent: safe to call when the cookie is absent.
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { deleteFlashCookie, type FlashCookieStore } from '@/lib/auth/flash-cookie';

const buildCookieStore = async (): Promise<FlashCookieStore> => {
  const store = await cookies();
  return {
    get: (name) => {
      const c = store.get(name);
      return c ? { value: c.value } : undefined;
    },
    set: (name, value, options) => {
      store.set(name, value, options);
    },
    delete: (name) => {
      store.delete(name);
    },
  };
};

export async function POST(): Promise<NextResponse> {
  const store = await buildCookieStore();
  deleteFlashCookie(store);
  return NextResponse.json({ ok: true });
}
