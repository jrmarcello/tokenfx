/**
 * Manager invite list row — REQ-21.
 *
 * Server Component. Renders a single `<tr>` for one invite. The row is
 * presentational; the only interactive surface is the revoke button, which
 * is itself a Client Component leaf (`<InviteRevokeButton>`) so this
 * component stays server-rendered.
 *
 * Status badge: derived `InviteStatus` is mapped to a Tailwind color tier:
 *   - `active`    → green (action: revoke is available)
 *   - `expired`   → gray (terminal, no action)
 *   - `exhausted` → yellow (terminal — used_count hit max_uses)
 *   - `revoked`   → red (terminal, no action)
 *
 * The revoke button is shown ONLY when the row is `active`. Other states
 * are terminal — there's nothing meaningful to revoke. We render an empty
 * cell instead of disabling so the column width stays stable.
 *
 * Date formatting: `formatRelativeExpiry` is intentionally chatty for
 * "soon" cases ("em 3h") and concise for distant ones ("em 5d"). For
 * already-expired rows we format as "expirou há …" so the manager can see
 * how stale the row is.
 */
import type { InviteListRow, InviteStatus } from '@/lib/queries/invites';
import { InviteRevokeButton } from './invite-revoke-button';

type Props = {
  row: InviteListRow;
};

const STATUS_LABEL: Record<InviteStatus, string> = {
  active: 'Ativo',
  expired: 'Expirado',
  exhausted: 'Esgotado',
  revoked: 'Revogado',
};

const STATUS_CLASSES: Record<InviteStatus, string> = {
  active:
    'bg-green-100 text-green-800 ring-1 ring-inset ring-green-600/20 dark:bg-green-900/40 dark:text-green-200 dark:ring-green-400/30',
  expired:
    'bg-neutral-100 text-neutral-700 ring-1 ring-inset ring-neutral-400/30 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-600',
  exhausted:
    'bg-yellow-100 text-yellow-800 ring-1 ring-inset ring-yellow-600/20 dark:bg-yellow-900/40 dark:text-yellow-200 dark:ring-yellow-400/30',
  revoked:
    'bg-red-100 text-red-800 ring-1 ring-inset ring-red-600/20 dark:bg-red-900/40 dark:text-red-200 dark:ring-red-400/30',
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Relative date label using a fixed scale (h/d). Avoids `Intl.RelativeTimeFormat`
 * to keep the label deterministic for E2E snapshots.
 */
const formatRelativeExpiry = (expiresAt: Date, now: Date): string => {
  const deltaMs = expiresAt.getTime() - now.getTime();
  const absMs = Math.abs(deltaMs);
  const past = deltaMs < 0;

  let label: string;
  if (absMs < HOUR_MS) {
    const mins = Math.max(1, Math.round(absMs / (60 * 1000)));
    label = `${mins}min`;
  } else if (absMs < DAY_MS) {
    const hours = Math.max(1, Math.round(absMs / HOUR_MS));
    label = `${hours}h`;
  } else {
    const days = Math.max(1, Math.round(absMs / DAY_MS));
    label = `${days}d`;
  }
  return past ? `há ${label}` : `em ${label}`;
};

export const InviteRow = ({ row }: Props) => {
  const now = new Date();
  const isActive = row.status === 'active';

  return (
    <tr data-testid={`invite-row-${row.tokenPrefix}`}>
      <td className="px-4 py-3 font-mono text-xs text-neutral-900 dark:text-neutral-100">
        {row.tokenPrefix}
        <span aria-hidden="true">…</span>
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[row.status]}`}
          data-testid={`invite-status-${row.tokenPrefix}`}
          data-status={row.status}
        >
          {STATUS_LABEL[row.status]}
        </span>
      </td>
      <td className="px-4 py-3 text-neutral-700 dark:text-neutral-300">
        {row.teamName ?? <span className="text-neutral-400">—</span>}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-neutral-700 dark:text-neutral-300">
        {row.emailPattern ?? <span className="text-neutral-400">qualquer</span>}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-neutral-900 dark:text-neutral-100">
        {row.usedCount}/{row.maxUses}
      </td>
      <td className="px-4 py-3 text-neutral-700 dark:text-neutral-300">
        {formatRelativeExpiry(row.expiresAt, now)}
      </td>
      <td className="px-4 py-3 text-neutral-700 dark:text-neutral-300">
        {row.createdByEmail ?? <span className="text-neutral-400">—</span>}
      </td>
      <td className="px-4 py-3 text-right">
        {isActive ? (
          <InviteRevokeButton tokenPrefix={row.tokenPrefix} />
        ) : null}
      </td>
    </tr>
  );
};
