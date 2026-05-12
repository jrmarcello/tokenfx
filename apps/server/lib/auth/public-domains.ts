/**
 * Public-email-domain blocklist for SSO auto-provisioning (T1.5 + threat
 * model §Decisão #3 of central-server-onboarding-v2-sso.threat-model.md).
 *
 * SSO auto-provision is REFUSED when the user's email domain matches any
 * entry here, even if the org has a matching `*@<domain>` invite pattern.
 * Rationale: public-email-provider patterns are footguns — managers may
 * inadvertently create wildcards that cover non-employees (gmail.com,
 * outlook.com, etc.).
 *
 * Governance (threat model §Decisão #13): infra team owns review cadence.
 * CI enforces the `LAST_REVIEWED` header is no older than 90 days via
 * `.github/workflows/lint-public-domains.yml`. CI fails if stale.
 *
 * LAST_REVIEWED: 2026-05-12
 */

const PUBLIC_DOMAINS = new Set<string>([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'gmx.com',
  'mail.ru',
  'qq.com',
  '163.com',
  'yandex.com',
  'duck.com',
]);

/**
 * Returns true when the given domain (case-insensitive) is in the
 * hardcoded public-email-provider blocklist.
 *
 * Input is normalized: NFC + lowercase + trim. Returns false for empty
 * string, malformed input, and any non-string.
 */
export const isPublicDomain = (domain: string): boolean => {
  if (typeof domain !== 'string' || domain.length === 0) return false;
  const normalized = domain.normalize('NFC').toLowerCase().trim();
  if (normalized.length === 0) return false;
  return PUBLIC_DOMAINS.has(normalized);
};
