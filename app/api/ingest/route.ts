import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db/client';
import { ingestAll } from '@/lib/ingest/writer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Defense in depth: this project is localhost-only. Both Host and Origin
// (when present) must point to loopback so a stray LAN bind or a forged
// Host via DNS rebinding can't trigger a filesystem scan + DB write.
const LOCALHOST_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://[::1]:3000',
]);
const DEFAULT_OTEL_URL = 'http://localhost:9464/metrics';

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
  const db = getDb();
  const otelUrl = process.env.OTEL_SCRAPE_URL ?? DEFAULT_OTEL_URL;
  const summary = await ingestAll({
    db,
    otelUrl,
    otelOptional: true,
    otelTimeoutMs: 1000,
  });
  revalidatePath('/');
  revalidatePath('/effectiveness');
  return NextResponse.json({ ok: true, summary });
}
