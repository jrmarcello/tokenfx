import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { upsertRating, getSessionIdForTurn } from '@/lib/queries/session';
import { revalidatePath } from 'next/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Defense in depth: this project is localhost-only. Both Host and Origin
// (when present) must point to loopback so a stray LAN bind or a forged
// Host via DNS rebinding can't mutate the DB from another origin.
const LOCALHOST_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://[::1]:3000',
]);

const BodySchema = z.object({
  turnId: z.string().min(1),
  rating: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  note: z.string().max(4096).nullable().optional(),
});

function isLocalhost(request: Request): boolean {
  const host = request.headers.get('host') ?? '';
  if (!LOCALHOST_HOST.test(host)) return false;
  const origin = request.headers.get('origin');
  if (origin && !ALLOWED_ORIGINS.has(origin)) return false;
  return true;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isLocalhost(request)) {
    return NextResponse.json(
      { error: { message: 'forbidden', code: 'FORBIDDEN' } },
      { status: 403 }
    );
  }
  const json = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { message: 'invalid body', code: 'VALIDATION_ERROR' } },
      { status: 400 }
    );
  }
  const db = getDb();
  upsertRating(
    db,
    parsed.data.turnId,
    parsed.data.rating,
    parsed.data.note ?? null
  );
  const sessionId = getSessionIdForTurn(db, parsed.data.turnId);
  if (sessionId) {
    revalidatePath(`/sessions/${sessionId}`);
  }
  revalidatePath('/');
  revalidatePath('/effectiveness');
  return NextResponse.json({ ok: true });
}
