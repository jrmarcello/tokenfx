/**
 * IP truncation helper for audit logging.
 *
 * Consolidates 3 paralllel impls that lived in `/api/health`,
 * `/api/onboarding/redeem-invite`, and `_drilldown/render.tsx`. See
 * `.specs/onboarding-followups-lowsev.md` for rationale and the bug fix
 * for malformed pseudo-IPv6 (`'2001:db8:abcd'` no longer slips through
 * the drilldown-grade impl).
 *
 * Returns the /24 CIDR string for IPv4 or /48 for IPv6. Rejects anything
 * malformed by returning `null` — defensive by default. Callers narrow
 * `null` from header reads at their boundary; the helper does not accept
 * `null`/`undefined` to keep ownership explicit.
 */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_HEXTET_RE = /^[0-9a-fA-F]{1,4}$/;

export const truncateIpForAudit = (raw: string): string | null => {
  const ip = raw.trim();
  if (ip.length === 0) return null;

  const m = ip.match(IPV4_RE);
  if (m) {
    const octets = [m[1], m[2], m[3], m[4]].map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }

  if (ip.includes(':')) {
    if (ip.startsWith('::')) return null;
    // Reject pseudo-IPv6 with only 3 colon-segments and no `::` shortcut
    // (e.g., '2001:db8:abcd') — not a valid address. The drilldown impl
    // accepted this silently and emitted '2001:db8:abcd::/48'.
    const allSegments = ip.split(':');
    if (allSegments.length < 4 && !ip.includes('::')) return null;
    const head = allSegments.slice(0, 3);
    if (head.length < 3 || head.some((h) => h.length === 0)) return null;
    if (!head.every((h) => IPV6_HEXTET_RE.test(h))) return null;
    return `${head.join(':').toLowerCase()}::/48`;
  }

  return null;
};
