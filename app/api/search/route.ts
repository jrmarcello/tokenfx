import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { searchTurns } from '@/lib/search/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Defense in depth: localhost-only, same pattern as /api/ingest and /api/ratings.
const LOCALHOST_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const QuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  days: z.coerce.number().int().min(0).max(3650).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function isLocalhost(request: Request): boolean {
  const host = request.headers.get('host') ?? '';
  if (!LOCALHOST_HOST.test(host)) return false;
  const origin = request.headers.get('origin');
  if (origin && !LOOPBACK_ORIGIN.test(origin)) return false;
  return true;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isLocalhost(request)) {
    return NextResponse.json(
      { error: { message: 'forbidden', code: 'FORBIDDEN' } },
      { status: 403 },
    );
  }
  const url = new URL(request.url);
  const raw = {
    q: url.searchParams.get('q') ?? '',
    days: url.searchParams.get('days') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  };
  const parsed = QuerySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { message: 'invalid query', code: 'VALIDATION_ERROR' } },
      { status: 400 },
    );
  }
  const db = getDb();
  const result = searchTurns(db, {
    query: parsed.data.q,
    days: parsed.data.days,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
  });
  return NextResponse.json(result);
}
