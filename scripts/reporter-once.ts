#!/usr/bin/env tsx
/**
 * One-shot reporter run.
 *
 * Invocations:
 *   pnpm reporter:once             # push real batch
 *   pnpm reporter:once --dry-run   # REQ-29 — print canonical JSON, no side effects
 *
 * The runtime gate inside `runReporter()` (REQ-11) means this exits
 * cleanly with `pushed=0` when `data/reporter-config.json` is absent,
 * never touching the network or DB.
 */
import { runReporter } from '@/lib/reporter/runner';
import { log } from '@/lib/logger';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

(async () => {
  try {
    const result = await runReporter({ dryRun });
    log.info(
      `[reporter:once] pushed=${result.pushed} skipped=${result.skipped} failed=${result.failed} queued=${result.queued}`,
    );
    process.exit(0);
  } catch (err) {
    log.error('[reporter:once] failed', { err });
    process.exit(1);
  }
})();
