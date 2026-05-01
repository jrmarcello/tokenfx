/**
 * POST /api/ingest — central ingestion endpoint (REQ-14, REQ-15, REQ-25, REQ-27, REQ-31).
 *
 * Two-level validation:
 *   Level 1: envelope schema with `.strict()` — unknown root keys reject the
 *            whole batch with HTTP 400.
 *   Level 2: each item in `payload[]` re-validated against the same
 *            `SanitizedSessionPayload` schema the reporter used (REQ-25).
 *            Per-item rejections collected in `errors[]`; valid siblings
 *            still ingest. Status remains 200.
 *
 * Auth: HMAC-SHA256 over the canonical JSON of `payload`. The server stores
 * the plaintext HMAC secret in `user_machines.secret_hash` (column name kept
 * for migration stability — see DEVIATION note below). Verification recomputes
 * the signature and compares with `timingSafeEqual` via `verify` helper.
 *
 * Idempotency: per-session SHA-256 hash of canonical JSON. If a row already
 * has the same hash, the item is skipped.
 *
 * Rate limit: in-memory bucket per `machine_id`, 100 req/min. 429 with
 * `Retry-After: 60`. Single-instance v1 design — upgrade to Redis when
 * scaling out.
 *
 * Audit: every request appends one `ingestion_log` row with truncated IP
 * (/24 IPv4, /48 IPv6).
 *
 * Per-user calibration recompute fires only when at least one accepted item
 * carries a positive `total_cost_usd_otel`.
 */
import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { canonicalJSON, verify } from '@root/reporter/signer';
import { SanitizedSessionPayload } from '@/lib/ingest/sanitizer-shared';
import { getDb } from '@/lib/db/client';
import {
  ingestionLog,
  modelBreakdownAgg,
  sessionsAgg,
  toolCountAgg,
  userMachines,
} from '@/lib/db/schema';
import { recomputePerUserCalibration } from '@/lib/queries/calibration';

// --- Rate limiter (in-memory, per-machine, per-minute) ------------------------
const RATE_LIMIT = 100;
const RATE_WINDOW_MS = 60_000;
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

const checkRateLimit = (machineId: string): boolean => {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(machineId);
  if (!bucket || bucket.resetAt < now) {
    rateLimitBuckets.set(machineId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT) return false;
  bucket.count += 1;
  return true;
};

// --- IP truncation (REQ-27) ---------------------------------------------------
const truncateIp = (ip: string | null): string | null => {
  if (!ip) return null;
  if (ip.includes(':')) {
    // IPv6 — keep first 3 hextets (/48). Reject if not at least 3 segments.
    const parts = ip.split(':');
    if (parts.length < 3) return null;
    return `${parts.slice(0, 3).join(':')}::/48`;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return `${parts.slice(0, 3).join('.')}.0/24`;
};

// --- Per-session payload hash (idempotency key — REQ-15) ----------------------
const payloadHashHex = (item: unknown): string =>
  createHash('sha256').update(canonicalJSON(item)).digest('hex');

// --- Envelope schema (level 1) ------------------------------------------------
const Envelope = z
  .object({
    version: z.literal(1),
    key_id: z.string().min(1),
    machine_id: z.string().uuid(),
    signature: z.string().regex(/^[0-9a-f]{64}$/),
    payload: z.array(z.unknown()).max(50),
  })
  .strict();

type RejectedItem = { session_id: string; reason: string };

const errorBody = (message: string, code?: string): { error: { message: string; code?: string } } =>
  code ? { error: { message, code } } : { error: { message } };

export const POST = async (req: NextRequest): Promise<NextResponse> => {
  // Parse JSON body. Malformed JSON → 400.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(errorBody('invalid JSON body'), { status: 400 });
  }

  // Level 1: envelope strict
  const env = Envelope.safeParse(body);
  if (!env.success) {
    return NextResponse.json(
      {
        error: {
          message: 'envelope validation failed',
          issues: env.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      },
      { status: 400 },
    );
  }

  // Rate limit (per machine_id) — REQ-31.
  if (!checkRateLimit(env.data.machine_id)) {
    return NextResponse.json(errorBody('rate limit exceeded'), {
      status: 429,
      headers: { 'Retry-After': '60' },
    });
  }

  const db = getDb();

  // Look up user_machines by key_id. Unknown / revoked → 401.
  const [machine] = await db
    .select({
      id: userMachines.id,
      userId: userMachines.userId,
      machineId: userMachines.machineId,
      secretHash: userMachines.secretHash,
      revokedAt: userMachines.revokedAt,
    })
    .from(userMachines)
    .where(eq(userMachines.keyId, env.data.key_id))
    .limit(1);

  if (!machine || machine.revokedAt !== null) {
    return NextResponse.json(errorBody('unknown or revoked key', 'unauthorized'), { status: 401 });
  }

  // Verify HMAC over the payload array. The plaintext HMAC secret is stored
  // in `secret_hash` (see DEVIATION note in module header).
  const sigOk = verify(env.data.payload, env.data.signature, machine.secretHash);
  if (!sigOk) {
    return NextResponse.json(errorBody('signature mismatch', 'unauthorized'), { status: 401 });
  }

  // Level 2: per-item validation (REQ-25 defense-in-depth)
  type AcceptedItem = z.infer<typeof SanitizedSessionPayload>;
  const accepted: AcceptedItem[] = [];
  const rejected: RejectedItem[] = [];
  for (const item of env.data.payload) {
    const parsed = SanitizedSessionPayload.safeParse(item);
    if (!parsed.success) {
      const sessionId =
        typeof item === 'object' && item !== null && 'session_id' in item &&
        typeof (item as { session_id?: unknown }).session_id === 'string'
          ? (item as { session_id: string }).session_id
          : '<unknown>';
      rejected.push({
        session_id: sessionId,
        reason: parsed.error.issues.map((i) => i.message).join('; '),
      });
      continue;
    }
    accepted.push(parsed.data);
  }

  // Open transaction. Any DB error rolls back the entire batch (REQ-14 TC-I-28).
  let acceptedCount = 0;
  let skippedCount = 0;
  let triggeredCalibration = false;

  try {
    await db.transaction(async (tx) => {
      for (const p of accepted) {
        const hash = payloadHashHex(p);

        // Check existing row hash for idempotency (REQ-15).
        const [existing] = await tx
          .select({ payloadHash: sessionsAgg.payloadHash })
          .from(sessionsAgg)
          .where(
            and(
              eq(sessionsAgg.userId, machine.userId),
              eq(sessionsAgg.sessionId, p.session_id),
            ),
          )
          .limit(1);
        if (existing && existing.payloadHash === hash) {
          skippedCount += 1;
          continue;
        }

        // Convert numeric epoch seconds to Date for timestamptz columns.
        const startedAt = new Date(p.started_at * 1000);
        const endedAt = new Date(p.ended_at * 1000);

        const baseValues = {
          userId: machine.userId,
          sessionId: p.session_id,
          payloadHash: hash,
          startedAt,
          endedAt,
          projectSlug: p.project_slug,
          gitBranch: p.git_branch,
          ccVersion: p.cc_version,
          totalInputTokens: p.total_input_tokens,
          totalOutputTokens: p.total_output_tokens,
          totalCacheReadTokens: p.total_cache_read_tokens,
          totalCacheCreationTokens: p.total_cache_creation_tokens,
          totalCostUsd: p.total_cost_usd.toString(),
          totalCostUsdOtel:
            p.total_cost_usd_otel !== null ? p.total_cost_usd_otel.toString() : null,
          turnCount: p.turn_count,
          toolCallCount: p.tool_call_count,
          avgRating: p.avg_rating !== null ? p.avg_rating.toString() : null,
          cacheHitRatio: p.cache_hit_ratio !== null ? p.cache_hit_ratio.toString() : null,
          outputInputRatio:
            p.output_input_ratio !== null ? p.output_input_ratio.toString() : null,
          subagentUsageRatio:
            p.subagent_usage_ratio !== null ? p.subagent_usage_ratio.toString() : null,
        };

        await tx
          .insert(sessionsAgg)
          .values(baseValues)
          .onConflictDoUpdate({
            target: [sessionsAgg.userId, sessionsAgg.sessionId],
            set: {
              payloadHash: hash,
              startedAt,
              endedAt,
              projectSlug: p.project_slug,
              gitBranch: p.git_branch,
              ccVersion: p.cc_version,
              totalInputTokens: p.total_input_tokens,
              totalOutputTokens: p.total_output_tokens,
              totalCacheReadTokens: p.total_cache_read_tokens,
              totalCacheCreationTokens: p.total_cache_creation_tokens,
              totalCostUsd: p.total_cost_usd.toString(),
              totalCostUsdOtel:
                p.total_cost_usd_otel !== null ? p.total_cost_usd_otel.toString() : null,
              turnCount: p.turn_count,
              toolCallCount: p.tool_call_count,
              avgRating: p.avg_rating !== null ? p.avg_rating.toString() : null,
              cacheHitRatio:
                p.cache_hit_ratio !== null ? p.cache_hit_ratio.toString() : null,
              outputInputRatio:
                p.output_input_ratio !== null ? p.output_input_ratio.toString() : null,
              subagentUsageRatio:
                p.subagent_usage_ratio !== null ? p.subagent_usage_ratio.toString() : null,
            },
          });

        // Replace child rows.
        await tx
          .delete(modelBreakdownAgg)
          .where(
            and(
              eq(modelBreakdownAgg.userId, machine.userId),
              eq(modelBreakdownAgg.sessionId, p.session_id),
            ),
          );
        if (p.model_breakdown.length > 0) {
          await tx.insert(modelBreakdownAgg).values(
            p.model_breakdown.map((m) => ({
              userId: machine.userId,
              sessionId: p.session_id,
              model: m.model,
              inputTokens: m.input_tokens,
              outputTokens: m.output_tokens,
              cacheReadTokens: m.cache_read_tokens,
              cacheCreationTokens: m.cache_creation_tokens,
              costUsd: m.cost_usd.toString(),
            })),
          );
        }

        await tx
          .delete(toolCountAgg)
          .where(
            and(
              eq(toolCountAgg.userId, machine.userId),
              eq(toolCountAgg.sessionId, p.session_id),
            ),
          );
        const toolEntries = Object.entries(p.tool_counts);
        if (toolEntries.length > 0) {
          await tx.insert(toolCountAgg).values(
            toolEntries.map(([toolName, count]) => ({
              userId: machine.userId,
              sessionId: p.session_id,
              toolName,
              count,
            })),
          );
        }

        if (p.total_cost_usd_otel !== null && p.total_cost_usd_otel > 0) {
          triggeredCalibration = true;
        }
        acceptedCount += 1;
      }

      // Audit log (REQ-27). One row per request, even on empty batches or
      // all-rejected batches.
      const ip =
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        req.headers.get('x-real-ip')?.trim() ??
        null;
      const payloadSize = Buffer.byteLength(JSON.stringify(env.data), 'utf8');
      await tx.insert(ingestionLog).values({
        userId: machine.userId,
        machineId: env.data.machine_id,
        keyId: env.data.key_id,
        payloadSizeBytes: payloadSize,
        acceptedCount,
        skippedCount,
        rejectedCount: rejected.length,
        requestIp: truncateIp(ip),
        errorsJson: rejected.length > 0 ? rejected : null,
      });

      // Per-user calibration recompute (REQ-19) — only when at least one
      // accepted item carried OTEL cost.
      if (triggeredCalibration) {
        await recomputePerUserCalibration(tx, machine.userId);
      }
    });
  } catch (err) {
    // Sanitize error message (security rule). Don't echo DB internals.
    const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : undefined;
    return NextResponse.json(
      errorBody('ingestion failed', code ?? 'internal_error'),
      { status: 500 },
    );
  }

  return NextResponse.json({
    accepted: acceptedCount,
    skipped: skippedCount,
    rejected: rejected.length,
    errors: rejected,
  });
};

// Test-only export to clear in-memory rate limiter between tests.
export const __resetRateLimiter = (): void => {
  rateLimitBuckets.clear();
};
