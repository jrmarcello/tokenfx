/**
 * Truncate a User-Agent string to at most 512 chars (REQ-4 of
 * .specs/central-server-onboarding-v2-sso.schema-migrations.md). Applied
 * at the application-write boundary before INSERT into
 * `onboarding_redemption_log.user_agent` or `auth_event_log.user_agent`.
 *
 * Operates on UTF-16 code units (JavaScript native slice). For ASCII
 * User-Agent strings (the overwhelming norm), this matches byte count.
 * For multi-byte characters, the truncation may split surrogate pairs;
 * acceptable for diagnostic logging.
 */
export const truncateUserAgent = (s: string): string => s.slice(0, 512);
