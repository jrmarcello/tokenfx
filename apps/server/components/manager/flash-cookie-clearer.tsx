'use client';

/**
 * Client-side trigger for the show-once flash cookie deletion.
 *
 * Why this exists: Next.js 15 forbids `cookies().delete()` from Server
 * Components — a Server Component can read cookies but cannot mutate
 * them. The show-once page (`/manager/invites/created`) reads the cookie
 * server-side to render the URL, then mounts this leaf which fires a
 * `useEffect` to POST `/api/onboarding/clear-flash` (a Route Handler).
 *
 * Why a Route Handler instead of a Server Action: any Server Action
 * invocation in Next.js 15 triggers an automatic RSC re-fetch of the
 * current route, which re-renders the Server Component, finds the cookie
 * already deleted, and falls through to the empty state. The user would
 * see the URL flash-and-disappear before they could copy it. A plain
 * `fetch` to a Route Handler avoids that round-trip — the rendered page
 * stays put until the user navigates away.
 *
 * One-shot semantics: after the POST lands, a reload finds the cookie
 * absent and falls through to empty state. The 120s cookie TTL is a
 * fail-safe for the rare case the user closes the tab before mount.
 *
 * Renders nothing — pure side-effect leaf.
 */
import { useEffect, useRef } from 'react';

export const FlashCookieClearer = (): null => {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void fetch('/api/onboarding/clear-flash', { method: 'POST' });
  }, []);
  return null;
};
