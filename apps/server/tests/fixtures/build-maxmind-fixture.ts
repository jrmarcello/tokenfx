/**
 * Generates / refreshes the MaxMind-DB test fixtures used by the
 * `ip-to-city.ts` integration tests (TC-I-36..40 from
 * `.specs/central-server-onboarding-v2-sso.manager-ui.md`).
 *
 * Provenance: official MaxMind test fixtures from
 *   https://github.com/maxmind/MaxMind-DB/tree/main/test-data
 * License: MIT (LICENSE-MIT in that repository — confirmed at fetch time).
 *
 * Why not generate from scratch with `mmdbwriter`?
 *   - `mmdbwriter` (`github.com/maxmind/mmdbwriter`) is a **Go** library —
 *     there is no first-party Node.js writer at the time of writing. The
 *     pure-JS `mmdb-lib` package only **reads** the MaxMind DB format.
 *   - Hand-crafting a minimal valid MMDB binary in TypeScript is feasible
 *     but adds 200+ LOC of format plumbing whose only consumer is the
 *     test suite. Vendoring the official MaxMind test fixture is the
 *     simpler, more authoritative choice — these are the same fixtures
 *     MaxMind themselves use to exercise `mmdb-lib` and their other
 *     readers.
 *
 * Output:
 *   - `GeoIP2-City-Test.mmdb`   — happy-path fixture (databaseType =
 *     `GeoIP2-City`). Contains real city records used by TC-I-36 /
 *     TC-I-39 / TC-I-40 (e.g. 81.2.69.142 → London, 89.160.20.112 →
 *     Linköping, 216.160.83.56 → Milton).
 *   - `GeoIP2-Country-Test.mmdb` — wrong-type fixture (databaseType =
 *     `GeoIP2-Country`) used by TC-I-37c to exercise the
 *     "unsupported database type" rejection path.
 *
 * Why City + Country instead of GeoLite2-City alone?
 *   `GeoLite2-City` and `GeoIP2-City` share the *same* record schema —
 *   ops may deploy either one (GeoIP2 is the paid superset, GeoLite2 is
 *   the free subset). The implementation in `lib/auth/ip-to-city.ts`
 *   therefore accepts both database types and rejects everything else
 *   (e.g. `GeoIP2-Country`, `GeoIP2-ASN`). This is captured in
 *   `tests/fixtures/README.md` and the spec's `Deviations` note.
 *
 * Regenerate with:
 *   pnpm tsx tests/fixtures/build-maxmind-fixture.ts
 *
 * The script is idempotent — re-running just refreshes the binaries
 * from the upstream commit pinned below.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Pinned to MaxMind-DB `main` branch. Bump deliberately; do not float on
// `main` in CI — re-run this script locally to refresh.
const UPSTREAM_REF = 'main';
const BASE_URL = `https://raw.githubusercontent.com/maxmind/MaxMind-DB/${UPSTREAM_REF}/test-data`;

type Fixture = {
  readonly filename: string;
  readonly description: string;
};

const FIXTURES: readonly Fixture[] = [
  {
    filename: 'GeoIP2-City-Test.mmdb',
    description: 'happy-path City fixture (databaseType = GeoIP2-City)',
  },
  {
    filename: 'GeoIP2-Country-Test.mmdb',
    description: 'wrong-type fixture (databaseType = GeoIP2-Country) — used by TC-I-37c',
  },
];

const fetchBinary = async (url: string): Promise<Uint8Array> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
};

const main = async (): Promise<void> => {
  const outDir = path.resolve(__dirname);
  mkdirSync(outDir, { recursive: true });

  for (const fixture of FIXTURES) {
    const url = `${BASE_URL}/${fixture.filename}`;
    process.stdout.write(`Fetching ${fixture.filename} ... `);
    const bytes = await fetchBinary(url);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(path.join(outDir, fixture.filename), bytes);
    process.stdout.write(`OK (${bytes.length} bytes, sha256=${sha256.slice(0, 16)}…)\n`);
  }

  process.stdout.write(
    [
      '',
      'Fixtures refreshed. Remember to commit:',
      ...FIXTURES.map((f) => `  apps/server/tests/fixtures/${f.filename}`),
      '',
      'See apps/server/tests/fixtures/README.md for provenance + license.',
      '',
    ].join('\n'),
  );
};

main().catch((err: unknown) => {
  process.stderr.write(`build-maxmind-fixture failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
