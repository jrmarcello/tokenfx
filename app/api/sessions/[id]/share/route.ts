import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { getSession, getTurns } from '@/lib/queries/session';
import { getSessionOtelStats } from '@/lib/queries/otel';
import { getSubagentBreakdown } from '@/lib/queries/subagent';
import { getCostCalibration } from '@/lib/queries/calibration';
import {
  renderSessionMarkdown,
  formatYyyymmdd,
} from '@/lib/share/session-markdown';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOCALHOST_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function isLocalhost(request: Request): boolean {
  const host = request.headers.get('host') ?? '';
  if (!LOCALHOST_HOST.test(host)) return false;
  const origin = request.headers.get('origin');
  if (origin && !LOOPBACK_ORIGIN.test(origin)) return false;
  return true;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isLocalhost(request)) {
    return NextResponse.json(
      { error: { message: 'forbidden', code: 'FORBIDDEN' } },
      { status: 403 },
    );
  }

  const { id } = await params;
  const url = new URL(request.url);
  const download = url.searchParams.get('download') === '1';
  const redact = url.searchParams.get('redact') === '1';

  const db = getDb();
  const session = getSession(db, id);
  if (!session) {
    return NextResponse.json(
      { error: { message: 'Session not found', code: 'SESSION_NOT_FOUND' } },
      { status: 404 },
    );
  }

  const turns = getTurns(db, id);
  const otel = getSessionOtelStats(db, id);
  const breakdown = getSubagentBreakdown(db, id);
  const calibration = getCostCalibration(db);
  const globalRate = calibration.get('global')?.rate ?? null;

  const body = renderSessionMarkdown(
    { session, turns, otel, breakdown, globalRate },
    { redact },
  );

  const headers: Record<string, string> = {
    'Content-Type': 'text/markdown; charset=utf-8',
  };
  if (download) {
    const dateStr = formatYyyymmdd(new Date());
    const safeId = encodeURIComponent(id);
    headers['Content-Disposition'] =
      `attachment; filename="tokenfx-session-${safeId}-${dateStr}.md"`;
  }

  return new Response(body, { status: 200, headers });
}
