/**
 * Pure email-pattern matcher for the onboarding redeem flow (REQ-16).
 *
 * Three pattern shapes are supported, intentionally narrow:
 *   1. `null`              → matches any email.
 *   2. `*@domain.com`      → matches any local-part on that domain (case-insensitive).
 *   3. `alice@domain.com`  → exact email match (case-insensitive).
 *
 * No other glob characters are supported. A `*` mid-string is treated as a
 * literal asterisk.
 *
 * **Why narrow:** domain-wildcard covers ~95% of real-world need (corporate
 * domains, "anyone @ acme.com can redeem"). Broader globs (`alice*@x.com`,
 * `*@*.com`, regex) invite footguns — accidentally over-broad invites that
 * leak access. We force the manager to either lock the invite to a single
 * email or to a single domain. Anything more permissive should be a
 * deliberate choice (multiple invites, or `null` pattern with explicit `max_uses`).
 *
 * **Security guards:**
 *   - Both inputs are Unicode-NFC-normalized before any comparison so the
 *     decomposed and composed forms of an accented character compare equal
 *     (TC-U-13).
 *   - Non-ASCII characters in the email's local-part are rejected to defend
 *     against homoglyph attacks (e.g. Cyrillic `а` U+0430 visually equals
 *     ASCII `a` U+0061; allowing this would let an attacker register an
 *     "alice@example.com" lookalike). The exception is when the pattern
 *     itself contains the same non-ASCII char and the comparison reduces
 *     to equality — the manager is opting in by typing it.
 *   - The domain part is run through `domainToASCII` (punycode) so IDN
 *     domains canonicalize before comparison.
 *
 * Pure function — no I/O, no DB, safe for Edge runtime if ever needed.
 */
import { domainToASCII } from 'node:url';

const NON_ASCII = /[^\x00-\x7F]/;

const splitEmail = (email: string): { local: string; domain: string } | null => {
  const atIndex = email.lastIndexOf('@');
  if (atIndex <= 0) return null; // `@example.com` (empty local) and `noatsign` both fail.
  if (atIndex === email.length - 1) return null; // `alice@` (empty domain).
  return { local: email.slice(0, atIndex), domain: email.slice(atIndex + 1) };
};

const canonicalizeDomain = (domain: string): string | null => {
  // `domainToASCII` returns '' on invalid IDN input.
  const ascii = domainToASCII(domain);
  if (ascii === '') return null;
  return ascii.toLowerCase();
};

export const matchEmailPattern = (
  pattern: string | null,
  email: string,
): boolean => {
  if (pattern === null) return true;
  if (email === '') return false;

  const normalizedEmail = email.normalize('NFC').toLowerCase();
  const normalizedPattern = pattern.normalize('NFC').toLowerCase();

  const emailParts = splitEmail(normalizedEmail);
  if (emailParts === null) return false;

  const emailDomain = canonicalizeDomain(emailParts.domain);
  if (emailDomain === null) return false;

  // Domain-wildcard pattern (`*@domain.com`).
  if (normalizedPattern.startsWith('*@')) {
    const patternDomainRaw = normalizedPattern.slice(2);
    const patternDomain = canonicalizeDomain(patternDomainRaw);
    if (patternDomain === null) return false;
    // Local-part homoglyph guard: when matching by domain wildcard the
    // local-part is unconstrained, so any non-ASCII in it is suspicious.
    if (NON_ASCII.test(emailParts.local)) return false;
    if (emailParts.local === '') return false; // TC-U-09: `@example.com` rejected.
    return emailDomain === patternDomain;
  }

  // Exact-match pattern.
  const patternParts = splitEmail(normalizedPattern);
  if (patternParts === null) return false;
  const patternDomain = canonicalizeDomain(patternParts.domain);
  if (patternDomain === null) return false;

  // If either side has non-ASCII in local-part, both sides must have
  // identical local-parts (post-NFC). The manager opted into the
  // non-ASCII char by typing it in the pattern; we still refuse to
  // *generalize* it, but allow exact equality.
  if (NON_ASCII.test(emailParts.local) || NON_ASCII.test(patternParts.local)) {
    return (
      emailParts.local === patternParts.local && emailDomain === patternDomain
    );
  }

  return (
    emailParts.local === patternParts.local && emailDomain === patternDomain
  );
};
