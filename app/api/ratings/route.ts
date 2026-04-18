import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { upsertRating } from '@/lib/queries/session';
import { revalidatePath } from 'next/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  turnId: z.string().min(1),
  rating: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  note: z.string().nullable().optional(),
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'invalid body' },
      { status: 400 }
    );
  }
  const db = getDb();
  migrate(db);
  upsertRating(
    db,
    parsed.data.turnId,
    parsed.data.rating,
    parsed.data.note ?? null
  );
  revalidatePath(`/sessions/${parsed.data.turnId}`);
  revalidatePath('/');
  return NextResponse.json({ ok: true });
}
