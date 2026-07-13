#!/usr/bin/env tsx
/**
 * Validate a hand-written `data/reporter-config.json` and generate the
 * `project_secret` field if it is missing.
 *
 * NOTE: this is NOT the interactive onboarding flow — that lives in the
 * carved-out spec `central-server-onboarding.md` (`pnpm reporter:setup`
 * will be re-introduced there). For v0 of THIS spec, devs hand-write the
 * config from a seeded `user_machines` row and run this script to:
 *
 *   1. fail loudly if the file is missing or malformed,
 *   2. mint a 32-byte hex `project_secret` if absent (REQ-7 — TC-I-01c),
 *   3. preserve file mode 0600 on write.
 *
 * The runtime config consumer (`lib/reporter/config.ts`) requires
 * `project_secret` to be present (`z.string().min(1)`); this init step
 * is what bridges a hand-written file (where `project_secret` may be
 * absent) into a runtime-valid one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { centralUrlSchema } from '@/lib/reporter/config';
import { log } from '@tokenfx/shared/logger';

const CONFIG_PATH = path.resolve(process.cwd(), 'data/reporter-config.json');

/**
 * Init-time schema: identical to the runtime `ReporterConfig` (see
 * `lib/reporter/config.ts`) EXCEPT `project_secret` is optional here —
 * we mint it on first run if absent. Mint must produce ≥ 64 hex chars
 * (32 random bytes) so the runtime `min(1)` check is satisfied with
 * room to spare.
 *
 * `central_url` reuses the shared `centralUrlSchema` from the runtime
 * config module so the https-unless-loopback transport rule is enforced
 * identically in both validators (single source of truth).
 */
const ConfigSchema = z
  .object({
    key_id: z.string().min(1),
    secret: z.string().min(1),
    machine_id: z.string().uuid(),
    user_email: z.string().email(),
    central_url: centralUrlSchema,
    project_secret: z.string().min(64).optional(),
  })
  .strict();

(async () => {
  if (!fs.existsSync(CONFIG_PATH)) {
    log.error(`[reporter:config-init] not found: ${CONFIG_PATH}`);
    log.info(
      '[reporter:config-init] hand-write this file based on your seeded user_machines row, OR see central-server-onboarding.md for the interactive flow (pnpm reporter:setup)',
    );
    process.exit(1);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    log.error('[reporter:config-init] invalid JSON', {
      message: (err as Error).message,
    });
    process.exit(1);
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    log.error('[reporter:config-init] invalid config', {
      issues: parsed.error.issues,
    });
    process.exit(1);
  }

  if (!parsed.data.project_secret) {
    const projectSecret = randomBytes(32).toString('hex');
    const updated = { ...parsed.data, project_secret: projectSecret };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), {
      mode: 0o600,
    });
    log.info('[reporter:config-init] generated project_secret (mode 0600)');
  } else {
    log.info(
      '[reporter:config-init] config valid, project_secret already set',
    );
  }
  process.exit(0);
})();
