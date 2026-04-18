import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { ingestAll } from '@/lib/ingest/writer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  const db = getDb();
  migrate(db);
  const summary = await ingestAll({ db, otelUrl: process.env.OTEL_SCRAPE_URL });
  revalidatePath('/');
  revalidatePath('/effectiveness');
  return NextResponse.json({ ok: true, summary });
}
