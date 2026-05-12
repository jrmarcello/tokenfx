# `apps/server/tests/fixtures/`

Test fixtures for the `@tokenfx/server` package. Files in this directory
are static (checked into git) so CI doesn't depend on network access or
licensed downloads.

## MaxMind DB fixtures

Files:

- `GeoIP2-City-Test.mmdb`    — happy-path fixture used by
  `tests/integration/ip-to-city-maxmind.test.ts` (TC-I-36 / TC-I-39 /
  TC-I-40).
- `GeoIP2-Country-Test.mmdb` — wrong-type fixture used by TC-I-37c to
  exercise the "unsupported database type" rejection path.

### Provenance

Both files are copied **verbatim** from the official MaxMind test-data
repository:

- Source: <https://github.com/maxmind/MaxMind-DB/tree/main/test-data>
- License: MIT (`LICENSE-MIT` in the upstream repo) — these are the
  same fixtures MaxMind themselves use to exercise `mmdb-lib` and other
  language readers.

### Regeneration

```bash
pnpm --filter @tokenfx/server tsx tests/fixtures/build-maxmind-fixture.ts
```

`build-maxmind-fixture.ts` fetches the latest upstream binaries from the
ref pinned in the script (default: `main`). After fetching, the script
prints sha256 prefixes so you can quickly spot upstream churn. Commit
the updated binaries with a clear message (e.g. `chore(fixtures):
refresh MaxMind test mmdbs to <upstream-commit-sha>`).

### Why not generate the binary from scratch?

The MaxMind ecosystem has no first-party Node.js **writer** for the MMDB
binary format — the canonical writer is the Go library
`github.com/maxmind/mmdbwriter`. The pure-JS `mmdb-lib` package only
**reads** MMDB files. Hand-rolling a TypeScript MMDB writer for our
fixture would add 200+ LOC of format plumbing whose only consumer is
this test suite. Vendoring MaxMind's own test fixtures is the
authoritative, lower-maintenance path.

### `databaseType` recognised by the implementation

`lib/auth/ip-to-city.ts` accepts mmdb files whose `databaseType` is
**either** `GeoLite2-City` **or** `GeoIP2-City` — they share the same
record schema (the former is the free subset of the latter). Anything
else (`GeoIP2-Country`, `GeoIP2-ASN`, etc.) is rejected with a single
warn log and the singleton enters a sticky "init-failed" state so
subsequent calls remain cheap.

The TC-I-37c assertion uses `GeoIP2-Country-Test.mmdb` to drive the
reject path because GitHub doesn't ship a `GeoLite2-*` fixture suffix —
the schemas are identical anyway, so the reject check is the same.

### IP → city mappings used by the tests

(All values come from `GeoIP2-City-Test.mmdb`. Inspect with
`pnpm tsx -e "..."` if you need to dig further.)

| IP | City | Country | Subdivision |
| -- | ---- | ------- | ----------- |
| `81.2.69.142`     | London    | United Kingdom | England                |
| `81.2.69.160`     | London    | United Kingdom | England                |
| `2.125.160.216`   | Boxford   | United Kingdom | England                |
| `175.16.199.1`    | Changchun | China          | Jilin Sheng            |
| `89.160.20.112`   | Linköping | Sweden         | Östergötland County    |
| `216.160.83.56`   | Milton    | United States  | Washington             |
