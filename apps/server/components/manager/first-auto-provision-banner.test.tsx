/**
 * Unit tests for `<FirstAutoProvisionBanner />` — TASK-17, REQ-1.
 *
 * `@testing-library/react` is not installed in this app — per TASK-17 brief
 * we fall back to rendering the component via `renderToStaticMarkup` and
 * asserting against the resulting HTML string. The component is a Server
 * Component with no hooks, so SSR-rendering is sufficient to validate the
 * happy paths.
 *
 * TC mappings (from spec §"Test Plan"):
 *   - TC-U-18 (happy): singular text renders for count = 1.
 *   - TC-U-19 (happy): plural text renders for count = 7.
 *
 * Plus a guard test for the +N more overflow (count > 5) so the visible
 * cap stays in sync with the spec.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { FirstAutoProvisionBanner } from './first-auto-provision-banner';
import type {
  FirstAutoProvisionAlert,
  FirstAutoProvisionEvent,
} from '@/lib/queries/manager-alerts';

const buildEvent = (
  i: number,
  overrides: Partial<FirstAutoProvisionEvent> = {},
): FirstAutoProvisionEvent => ({
  eventId: 1000 + i,
  receivedAt: new Date(Date.UTC(2026, 4, 12, 10, i, 0)),
  emailHashPrefix: `hash${i.toString().padStart(4, '0')}`.slice(0, 8),
  ssoProvider: 'google',
  ...overrides,
});

const buildAlert = (
  count: number,
  events: ReadonlyArray<FirstAutoProvisionEvent>,
): FirstAutoProvisionAlert => ({
  count,
  events,
  latestAt: events[0]?.receivedAt ?? new Date(0),
});

describe('<FirstAutoProvisionBanner />', () => {
  it('renders the singular headline for exactly one event', () => {
    const alert = buildAlert(1, [buildEvent(1)]);
    const html = renderToStaticMarkup(<FirstAutoProvisionBanner alert={alert} />);
    expect(html).toContain(
      '1 developer was auto-onboarded via SSO in the last 7 days',
    );
    // The single event's ack form is rendered with the event_id wired in.
    expect(html).toContain('name="event_id"');
    expect(html).toContain('value="1001"');
    // Privacy: only the hash prefix appears, never a full hash or email.
    expect(html).toContain('hash0001');
    // Pin the prefix-only invariant: rendered HTML must never contain an
    // `@` (email shape) — a future refactor that accidentally surfaces the
    // full `emailHash` field would be caught here.
    expect(html).not.toContain('@');
    // Audit-log link is present.
    expect(html).toContain('/manager/audit-log');
  });

  it('renders the plural headline for more than one event', () => {
    const events = [1, 2, 3, 4, 5, 6, 7].map((i) => buildEvent(i));
    const alert = buildAlert(7, events);
    const html = renderToStaticMarkup(<FirstAutoProvisionBanner alert={alert} />);
    expect(html).toContain(
      '7 developers were auto-onboarded via SSO in the last 7 days',
    );
    // Overflow indicator: 7 events, only 5 visible → "+2 more".
    expect(html).toContain('+2 more');
  });

  it('renders up to 5 events inline; remaining collapse into +N more', () => {
    const events = [1, 2, 3, 4, 5, 6].map((i) => buildEvent(i));
    const alert = buildAlert(6, events);
    const html = renderToStaticMarkup(<FirstAutoProvisionBanner alert={alert} />);
    // Top-5 event_ids visible.
    for (const id of [1001, 1002, 1003, 1004, 1005]) {
      expect(html).toContain(`value="${id}"`);
    }
    // Event 6 (id 1006) does NOT render an inline ack form.
    expect(html).not.toContain('value="1006"');
    // Overflow surfaces as +1 more.
    expect(html).toContain('+1 more');
  });

  it('renders no overflow indicator when count matches visible events', () => {
    const events = [1, 2, 3].map((i) => buildEvent(i));
    const alert = buildAlert(3, events);
    const html = renderToStaticMarkup(<FirstAutoProvisionBanner alert={alert} />);
    expect(html).not.toContain('more — review in the audit log');
  });

  it('falls back to "unknown" when ssoProvider is null (legacy rows)', () => {
    const alert = buildAlert(1, [buildEvent(1, { ssoProvider: null })]);
    const html = renderToStaticMarkup(<FirstAutoProvisionBanner alert={alert} />);
    expect(html).toContain('via unknown');
  });
});
