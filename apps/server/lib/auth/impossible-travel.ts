/**
 * Impossible-travel baseline anomaly heuristic
 * (central-server-onboarding-v2-sso.backend.md — Decisão #7).
 *
 * Fires `{ alert: true }` when the most recent prior `accepted-sso-auto`
 * event for the same `sso_subject_hash` happened within 1 hour AND from a
 * city more than 500km away (haversine) from the current event's city.
 *
 * Data-light v2 baseline: no ML, no learned thresholds, no per-user
 * baseline. The hardcoded CITY_COORDS table is intentionally minimal —
 * full geo coverage lands when `ipToCity` is wired to MaxMind (future
 * spec). Until then, unknown cities (current or prior) short-circuit to
 * `{ alert: false }` so the heuristic is fail-safe (no false positives
 * from missing data).
 *
 * IMPORTANT: the caller MUST invoke `checkImpossibleTravel` BEFORE
 * `writeAuthEvent` for the current event — the query orders by
 * `occurred_at DESC LIMIT 1`, and if the current event is already
 * inserted, the function would compare the current event to itself.
 */
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { authEventLog } from '@/lib/db/schema';

export type ImpossibleTravelResult =
  | { alert: false }
  | { alert: true; reason: string };

/**
 * Hardcoded city → (lat, lng). Keys match the strings returned by
 * `ipToCity` (currently stub-only returns null). Seed list covers the
 * cities exercised by the test plan; expansion lands with MaxMind wiring.
 *
 * Coordinate source: Wikipedia "List of largest cities by population"
 * (rounded to 4 decimal places — ~11m precision; plenty for a 500km
 * threshold).
 *
 * `TestCity{A,B,C}` are synthetic fixtures engineered for boundary tests
 * (TC-U-30, TC-U-31): exactly 500km and 500km+epsilon apart at the
 * equator, where haversine is dominated by the latitude delta and the
 * geometry collapses to a pure great-circle on a meridian.
 */
const CITY_COORDS: Readonly<Record<string, { lat: number; lng: number }>> = {
  'New York': { lat: 40.7128, lng: -74.006 },
  Tokyo: { lat: 35.6762, lng: 139.6503 },
  London: { lat: 51.5074, lng: -0.1278 },
  Paris: { lat: 48.8566, lng: 2.3522 },
  'San Francisco': { lat: 37.7749, lng: -122.4194 },
  // ---- Boundary test fixtures (TC-U-30, TC-U-31). All on the prime meridian
  // so haversine degenerates to R * |Δφ|; this lets us hit *exact* 500km and
  // 500.01km without floating-point slop affecting the assertion. ----
  TestCityA: { lat: 0, lng: 0 },
  // 500km north of TestCityA along the meridian.
  // distance = R * Δφ_rad → Δφ_rad = 500/6371 → Δφ_deg = (500/6371) * (180/π)
  TestCityB: { lat: (500 / 6371) * (180 / Math.PI), lng: 0 },
  // 500.01km north of TestCityA — just past the threshold.
  TestCityC: { lat: (500.01 / 6371) * (180 / Math.PI), lng: 0 },
};

/**
 * Earth's mean radius in km. Standard haversine reference value.
 */
const EARTH_RADIUS_KM = 6371;

/**
 * 1-hour window in milliseconds. Strict-less-than comparison: a prior
 * event exactly 3,600,000ms ago does NOT trigger the heuristic.
 */
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Distance threshold in km. Strict-greater-than comparison: a 500.0km
 * separation does NOT trigger; 500.01km does.
 */
const DISTANCE_THRESHOLD_KM = 500;

/**
 * Haversine great-circle distance between two lat/lng points, in km.
 * Inline (no external dep) — the function fits in ~10 LOC and a runtime
 * dependency would be overkill for a single use site.
 */
const haversineKm = (
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number => {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
};

/**
 * Returns `{ alert: true, reason }` when the most recent prior
 * `accepted-sso-auto` event for `ssoSubjectHash` was within 1 hour AND
 * the haversine distance between the prior city and `currentCity` is
 * strictly greater than 500km.
 *
 * Returns `{ alert: false }` when ANY of:
 *   - `currentCity` is null
 *   - `currentCity` is unknown to `CITY_COORDS`
 *   - No prior `accepted-sso-auto` event exists for this subject
 *   - Prior event's city is null
 *   - Prior city is unknown to `CITY_COORDS`
 *   - Elapsed time ≥ 1 hour
 *   - Distance ≤ 500km
 *
 * Caller contract: invoke BEFORE inserting the current event into
 * `auth_event_log` — the query has no exclusion clause and would
 * otherwise compare the current event to itself.
 */
export const checkImpossibleTravel = async (
  ssoSubjectHash: string,
  currentCity: string | null,
  currentTimeMs: number,
): Promise<ImpossibleTravelResult> => {
  if (currentCity === null) return { alert: false };
  const currentCoords = CITY_COORDS[currentCity];
  if (!currentCoords) return { alert: false };

  const db = getDb();
  // Query the most recent prior accepted-sso-auto event for this subject.
  // Indexed by (sso_subject_hash, occurred_at) — see schema.ts:660.
  const rows = await db
    .select({ city: authEventLog.city, occurredAt: authEventLog.occurredAt })
    .from(authEventLog)
    .where(
      and(
        eq(authEventLog.ssoSubjectHash, ssoSubjectHash),
        eq(authEventLog.outcome, 'accepted-sso-auto'),
      ),
    )
    .orderBy(desc(authEventLog.occurredAt))
    .limit(1);

  if (rows.length === 0) return { alert: false };
  // Safe non-null: length check above guarantees rows[0] exists.
  const prior = rows[0]!;
  if (prior.city === null) return { alert: false };

  const elapsedMs = currentTimeMs - prior.occurredAt.getTime();
  // Strict less-than: 1h exactly does NOT trigger.
  if (elapsedMs >= ONE_HOUR_MS) return { alert: false };

  const priorCoords = CITY_COORDS[prior.city];
  if (!priorCoords) return { alert: false };

  const distanceKm = haversineKm(priorCoords, currentCoords);
  // Strict greater-than: 500km exactly does NOT trigger.
  if (distanceKm <= DISTANCE_THRESHOLD_KM) return { alert: false };

  return {
    alert: true,
    reason: `impossible-travel: ${prior.city} -> ${currentCity} in ${Math.floor(elapsedMs / 60000)}min (${Math.round(distanceKm)}km)`,
  };
};
