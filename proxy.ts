import { NextResponse, type NextRequest } from 'next/server';

/**
 * Real HTTP 404 for nonexistent sessions (REQ-6 of
 * .specs/fix-pricing-unknown-model-family.md).
 *
 * Why proxy (middleware): every rendering-time mechanism (notFound() in the page
 * body, notFound() in generateMetadata + htmlLimitedBots) commits a 200
 * before the check runs, because the root `app/loading.tsx` boundary flushes
 * the shell immediately for dynamic routes. Only the proxy runs before the
 * response status is committed.
 *
 * Proxy always runs on the Node.js runtime in Next 16, so it can open the
 * SQLite DB directly. A brand-new not-yet-ingested session is handled by a
 * coalesced ensureFreshIngest() + re-check before returning 404.
 */
export const config = {
  // Single dynamic segment — the only route under /sessions/ is
  // app/sessions/[id]/page.tsx. Deeper paths 404 via Next's own router.
  matcher: '/sessions/:id',
};

export async function proxy(req: NextRequest) {
  const raw = req.nextUrl.pathname
    .replace(/^\/sessions\//, '')
    .replace(/\/.*$/, '');
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // Malformed %-sequence (e.g. /sessions/%ZZ) — treat as "no such
    // session" instead of letting URIError bubble into a 500.
    return NextResponse.rewrite(req.nextUrl, { status: 404 });
  }
  if (!id) return NextResponse.next();

  // Lazy imports keep the native better-sqlite3 module out of the module
  // graph until a /sessions/[id] request actually arrives (belt-and-
  // suspenders against any future Edge-bundling regression; on Node the
  // module cache makes repeat imports free).
  const { getDb } = await import('@/lib/db/client');
  const { getSession } = await import('@/lib/queries/session');

  // Note: the page (generateMetadata + body) re-runs getSession and
  // ensureFreshIngest for the same request. That double-check is a
  // deliberate tradeoff — both are cheap (prepared statement; mtime
  // short-circuit) and removing the page-side checks would couple page
  // correctness to this proxy's existence. Do not "optimize" it away.
  const db = getDb();
  if (getSession(db, id)) return NextResponse.next();

  // Not found — could be a session written to disk but not yet ingested
  // (pull-based ingest contract). Run the coalesced ingest once, re-check.
  const { ensureFreshIngest } = await import('@/lib/ingest/auto');
  await ensureFreshIngest();
  if (getSession(getDb(), id)) return NextResponse.next();

  // Rewrite to Next's own not-found rendering with a real 404 status: the
  // page body still renders its friendly 404 (the page calls notFound()),
  // while the status here is authoritative.
  return NextResponse.rewrite(req.nextUrl, { status: 404 });
}
