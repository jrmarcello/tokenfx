/**
 * IP → city geolocation lookup (MaxMind-backed).
 *
 * Spec: `.specs/central-server-onboarding-v2-sso.manager-ui.md` TASK-9
 * (REQ-16 / REQ-17). Supersedes the spec-b stub that always returned
 * null; callers (`auth-event-log-writer.ts`, `impossible-travel.ts`)
 * already handle null gracefully, so this change is a strict
 * enrichment — no caller updates are required.
 *
 * Behaviour summary
 *   1. Reads `process.env.MAXMIND_DB_PATH` **lazily** on first call. If
 *      unset, every call returns null cheaply (no fs / DB work).
 *   2. Private / loopback / non-routable IPs are rejected inline
 *      (RFC 1918, RFC 3927, RFC 4193, IPv4/IPv6 loopback) before the
 *      reader is consulted. This avoids leaking ops-network topology
 *      into the city column.
 *   3. The reader is initialised through a Promise-gate singleton so
 *      two concurrent first calls share the same `Promise<Reader>`
 *      (no double-open race). Once the Promise resolves the reader is
 *      cached; once it rejects the singleton enters a sticky
 *      "init-failed" state so subsequent calls remain cheap.
 *   4. Each failure mode (file missing, file corrupt, unsupported
 *      `databaseType`) logs ONE `log.warn` line via the shared logger,
 *      then returns null forever for this process. The dedup flag lives
 *      in module scope so re-imports under `vi.resetModules()` get a
 *      clean slate, which matches how the integration tests assert
 *      "warns once".
 *   5. Accepts both `GeoLite2-City` and `GeoIP2-City` database types —
 *      they share the same record schema (the former is the free
 *      subset). Ops may deploy either binary; the code is brand-
 *      agnostic. Anything else (Country / ASN / etc.) is rejected.
 *
 * Privacy: city names are coarse-grained (no street / lat-lng) and are
 * the only field surfaced to the auth_event_log table — matches the
 * privacy invariants spelled out in the threat model.
 */
import { isIP } from 'node:net';

import { log as logger } from '@tokenfx/shared/logger';
import { open as openMaxmindDb, type Reader, type CityResponse } from 'maxmind';

/**
 * The narrow subset of `databaseType` strings the implementation will
 * accept. `GeoLite2-City` is the free download; `GeoIP2-City` is the
 * paid superset — they share the exact same record schema, so the
 * lookup code below works identically against either.
 */
const SUPPORTED_DATABASE_TYPES: ReadonlySet<string> = new Set([
  'GeoLite2-City',
  'GeoIP2-City',
]);

/**
 * Singleton state. Three terminal shapes:
 *   - `null`                 — uninitialised (no first call has fired)
 *   - `Promise<Reader|null>` — init in flight (Promise-gate)
 *   - resolved `Reader`      — happy path
 *   - resolved `null`        — sticky init-failed (subsequent calls cheap)
 */
let readerPromise: Promise<Reader<CityResponse> | null> | null = null;

/**
 * Module-level "have we warned for this process?" flag. One single
 * boolean is sufficient because the four failure modes all converge on
 * the same outcome (sticky null + a warn). Tests reset the flag by
 * re-importing the module under `vi.resetModules()`.
 */
let warnedForInitFailure = false;

/** Surface a warn line ONCE per process for any init-time failure. */
const warnOnce = (reason: string, detail: Record<string, unknown>): void => {
  if (warnedForInitFailure) return;
  warnedForInitFailure = true;
  logger.warn('ipToCity disabled', { reason, ...detail });
};

/**
 * Initialise the MaxMind reader. Resolves to `null` on every recoverable
 * failure (missing env, missing file, corrupt binary, wrong type) so the
 * caller's null-check covers every disabled state uniformly.
 *
 * The function MUST be invoked through `getReader()` (below) so the
 * Promise-gate semantics are preserved.
 */
const initReader = async (): Promise<Reader<CityResponse> | null> => {
  const dbPath = process.env.MAXMIND_DB_PATH;
  if (dbPath === undefined || dbPath.length === 0) {
    // Env unset: not an error, just disabled. We deliberately do NOT
    // emit a warn here because a fresh deployment without MaxMind
    // configured is the documented default state.
    return null;
  }

  let reader: Reader<CityResponse>;
  try {
    reader = await openMaxmindDb<CityResponse>(dbPath);
  } catch (err) {
    // Covers ENOENT (missing file) AND parse errors (corrupt binary,
    // truncated metadata, unknown record_size, etc.). `maxmind.open`
    // never resolves successfully when these happen — the rejection
    // is the only failure signal we need.
    warnOnce('open-failed', {
      // SECURITY: log basename only — full path leaks deployment topology
      // when logs are forwarded to external sinks (Sentry, etc.). Basename
      // is enough to disambiguate `GeoLite2-City.mmdb` vs `GeoIP2-City.mmdb`.
      pathBasename: dbPath.split('/').pop() ?? '<unknown>',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const dbType = reader.metadata.databaseType;
  if (!SUPPORTED_DATABASE_TYPES.has(dbType)) {
    warnOnce('unsupported-database-type', {
      // SECURITY: log basename only — full path leaks deployment topology
      // when logs are forwarded to external sinks (Sentry, etc.). Basename
      // is enough to disambiguate `GeoLite2-City.mmdb` vs `GeoIP2-City.mmdb`.
      pathBasename: dbPath.split('/').pop() ?? '<unknown>',
      databaseType: dbType,
      supported: Array.from(SUPPORTED_DATABASE_TYPES),
    });
    return null;
  }

  return reader;
};

/**
 * Promise-gate singleton accessor. Concurrent first callers share the
 * same in-flight Promise so we open the DB exactly once per process.
 */
const getReader = (): Promise<Reader<CityResponse> | null> => {
  if (readerPromise === null) {
    readerPromise = initReader();
  }
  return readerPromise;
};

// --- Private-IP guards -----------------------------------------------

/** Parse a dotted-quad IPv4 into 4 octets, or null if malformed. */
const parseIpv4 = (ip: string): readonly [number, number, number, number] | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]+$/.test(part)) return null;
    const n = Number.parseInt(part, 10);
    if (!Number.isFinite(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return [octets[0], octets[1], octets[2], octets[3]] as const;
};

/** RFC 1918 / RFC 3927 / loopback / link-local / CGNAT / etc. */
const isPrivateIpv4 = (ip: string): boolean => {
  const octets = parseIpv4(ip);
  if (octets === null) return false;
  const [a, b] = octets;
  if (a === 10) return true;             // 10.0.0.0/8
  if (a === 127) return true;            // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT, RFC 6598)
  if (a === 0) return true;              // 0.0.0.0/8
  if (a >= 224) return true;             // multicast + reserved
  return false;
};

/** ::1, fc00::/7, fe80::/10, etc. */
const isPrivateIpv6 = (ip: string): boolean => {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  if (lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA (fc00::/7)
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // link-local fe80::/10
  }
  return false;
};

const isUnroutable = (ip: string, family: 4 | 6): boolean =>
  family === 4 ? isPrivateIpv4(ip) : isPrivateIpv6(ip);

// --- Public API ------------------------------------------------------

/**
 * Resolve an IP address to a coarse-grained city name, or null when:
 *   - the IP is empty / whitespace / malformed
 *   - the IP is private / loopback / link-local / multicast
 *   - MaxMind is disabled (env unset, file missing, corrupt, wrong type)
 *   - the IP is routable but absent from the configured database
 *
 * Signature is intentionally unchanged from the spec-b stub so consumers
 * (`auth-event-log-writer.ts`, `impossible-travel.ts`) don't need any
 * edits. Returns a Promise so future swap-in of an HTTP-backed lookup
 * (web-service mode) is a drop-in change.
 */
export const ipToCity = async (ip: string): Promise<string | null> => {
  const trimmed = ip.trim();
  if (trimmed.length === 0) return null;

  const family = isIP(trimmed);
  if (family === 0) return null; // malformed
  if (isUnroutable(trimmed, family === 4 ? 4 : 6)) return null;

  const reader = await getReader();
  if (reader === null) return null;

  let record: CityResponse | null;
  try {
    record = reader.get(trimmed);
  } catch {
    // `Reader.get` is meant to be synchronous + throw only on invalid
    // input — we've already filtered malformed input above, so a throw
    // here would be a library / fixture bug. Treat as a "no record"
    // outcome and surface null; do NOT warn (would spam on every odd
    // IP). The warn-once budget is reserved for init failures.
    return null;
  }
  if (record === null) return null;

  const cityName = record.city?.names?.en;
  return typeof cityName === 'string' && cityName.length > 0 ? cityName : null;
};
