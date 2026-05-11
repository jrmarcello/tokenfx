'use client';

/**
 * Invite-creation form — REQ-22.
 *
 * Client Component because we need:
 *
 *   - `crypto.randomUUID()` for the idempotency key (generated once on
 *     mount via `useState` initializer — re-renders keep the same key,
 *     but a remount produces a new one). Server-rendering would force a
 *     deterministic key (bad) or a per-request UUID (no longer
 *     idempotent across the same React tree refresh).
 *
 *   - `useTransition` to drive the submit button's pending state without
 *     blocking the rest of the page.
 *
 *   - `useRouter().push` to navigate to `/manager/invites/created` after
 *     the Server Action sets the show-once flash cookie. We do NOT
 *     `router.refresh()` first — the redirect is enough; the cookie is
 *     set in the same response cycle.
 *
 * Validation: we mirror the server-side Zod constraints in the input
 * `min`/`max` attributes so the browser-native form blocks obvious bad
 * input. Server-side Zod is still authoritative — these client hints are
 * UX, not security.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createInviteAction } from '@/app/manager/invites/actions';

type TeamOption = {
  id: string;
  name: string;
};

type Props = {
  teams: ReadonlyArray<TeamOption>;
};

const ERROR_LABEL: Record<string, string> = {
  unauthorized: 'Session expired. Reload the page.',
  invalid_input: 'Invalid form data. Check the fields.',
};

export const InviteCreateForm = ({ teams }: Props) => {
  // Lazy initializer — runs ONCE per mount. A re-render with new props
  // doesn't regenerate the key, so a fast double-click (which would
  // normally fire two submits before the first round-trips) reuses the
  // same idempotency key and gets the cached result the second time.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const onSubmit = (formData: FormData) => {
    setError(null);
    startTransition(async () => {
      const result = await createInviteAction(formData);
      if (!result.ok) {
        setError(ERROR_LABEL[result.code] ?? 'Error creating invite.');
        return;
      }
      // Server Action set the flash cookie scoped to /manager/invites/created.
      router.push('/manager/invites/created');
    });
  };

  return (
    <form
      action={onSubmit}
      className="space-y-5 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      data-testid="invite-create-form"
    >
      {/* Idempotency key — same value across re-renders, regenerates on remount. */}
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />

      <div className="space-y-1.5">
        <label
          htmlFor="invite-team"
          className="block text-sm font-medium text-neutral-900 dark:text-neutral-100"
        >
          Team
        </label>
        <select
          id="invite-team"
          name="team_id"
          defaultValue=""
          className="w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
        >
          <option value="">(no team — org-wide invite)</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Links the user to a team when redeemed. Optional.
        </p>
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor="invite-email-pattern"
          className="block text-sm font-medium text-neutral-900 dark:text-neutral-100"
        >
          Email pattern
        </label>
        <input
          id="invite-email-pattern"
          name="email_pattern"
          type="text"
          maxLength={254}
          placeholder="*@company.com — empty for any"
          className="w-full rounded border border-neutral-300 bg-white px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
        />
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Restricts redemption. Empty = any email.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label
            htmlFor="invite-max-uses"
            className="block text-sm font-medium text-neutral-900 dark:text-neutral-100"
          >
            Max uses
          </label>
          <input
            id="invite-max-uses"
            name="max_uses"
            type="number"
            min={1}
            max={100}
            defaultValue={1}
            required
            className="w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            1–100. Default 1.
          </p>
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="invite-expires"
            className="block text-sm font-medium text-neutral-900 dark:text-neutral-100"
          >
            Expires in (hours)
          </label>
          <input
            id="invite-expires"
            name="expires_in_hours"
            type="number"
            min={1}
            max={168}
            defaultValue={8}
            required
            className="w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            1–168 (7 days). Default 8h.
          </p>
        </div>
      </div>

      {error ? (
        <p
          className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
          role="alert"
          data-testid="invite-create-error"
        >
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md bg-neutral-900 px-4 text-sm font-medium text-neutral-50 shadow transition-colors hover:bg-neutral-900/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-950 disabled:opacity-50 dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-neutral-50/90 dark:focus-visible:ring-neutral-300"
          data-testid="invite-create-submit"
        >
          {isPending ? 'Creating…' : 'Create'}
        </button>
      </div>
    </form>
  );
};
