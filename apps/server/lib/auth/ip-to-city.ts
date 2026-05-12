/**
 * IP → city geolocation lookup (v2 baseline stub).
 *
 * Returns null in spec b (central-server-onboarding-v2-sso.backend.md
 * REQ-21). A future spec wires MaxMind GeoLite2 or equivalent; consumers
 * (`auth-event-log-writer.ts`, `impossible-travel.ts`) handle null
 * gracefully (NULL DB column, skip heuristic).
 *
 * Interface stable: keeps `ip: string` so the signature is unchanged when
 * the real backend lands. The unused-vars suppression is scoped to this
 * stub — when MaxMind is wired in, `ip` will be consumed and the comment
 * removed.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- v2 stub; param consumed when MaxMind backend lands
export const ipToCity = async (ip: string): Promise<string | null> => {
  return null;
};
