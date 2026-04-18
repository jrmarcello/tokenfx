import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db/client';
import { ingestAll } from '@/lib/ingest/writer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOCALHOST_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export async function POST(request: Request): Promise<NextResponse> {
  // Defense in depth: this project is localhost-only. Reject requests that
  // don't come from a loopback Host header so a stray LAN bind can't trigger
  // a full filesystem scan + DB write.
  const host = request.headers.get('host') ?? '';
  if (!LOCALHOST_HOST.test(host)) {
    return NextResponse.json(
      { ok: false, error: 'forbidden' },
      { status: 403 }
    );
  }
  const db = getDb();
  const summary = await ingestAll({ db, otelUrl: process.env.OTEL_SCRAPE_URL });
  revalidatePath('/');
  revalidatePath('/effectiveness');
  return NextResponse.json({ ok: true, summary });
}
