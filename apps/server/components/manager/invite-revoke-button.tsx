'use client';

/**
 * Revoke-confirmation button — REQ-21 / REQ-22.
 *
 * Opens a native `<dialog>` (no shadcn `<AlertDialog>` available in this
 * app's component set) for confirmation. We use `<dialog>` instead of a
 * portal-driven custom modal because:
 *
 *   - The DOM `<dialog>` element provides a built-in focus trap, ESC-to-close
 *     and `inert` semantics for the rest of the page (a11y wins).
 *   - It works with progressive enhancement: no portal, no z-index war, and
 *     server-rendered surrounding markup remains stable.
 *
 * The dialog wraps a `<form action={revokeFormAction}>`. The form action is
 * a thin Server-Action adapter declared inside this Client Component (Server
 * Actions imported from a Client Component must be `'use server'` modules,
 * and `revokeInviteAction` already is — but it takes a string, not FormData,
 * so we adapt it inline). On success/failure we reset the dialog state and
 * `router.refresh()` so the row repaints with `status=revoked`.
 */
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { revokeInviteAction } from '@/app/manager/invites/actions';

type Props = {
  tokenPrefix: string;
};

export const InviteRevokeButton = ({ tokenPrefix }: Props) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const openDialog = () => {
    setError(null);
    dialogRef.current?.showModal();
  };

  const closeDialog = () => {
    dialogRef.current?.close();
  };

  const handleConfirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await revokeInviteAction(tokenPrefix);
      if (!result.ok) {
        // Map the Server-Action error codes to friendly Portuguese copy.
        // We never surface the raw code to the user, only a short label.
        if (result.code === 'not_found') {
          setError('Convite não encontrado.');
        } else if (result.code === 'collision') {
          setError(
            'Conflito de prefixo. Recarregue a página e tente novamente.',
          );
        } else if (result.code === 'invalid_input') {
          setError('Prefixo inválido.');
        } else {
          setError('Não foi possível revogar.');
        }
        return;
      }
      // Both `revoked` and `already-revoked` are success states for the
      // user — close the modal and let the server refresh the list.
      closeDialog();
      router.refresh();
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="inline-flex h-7 items-center justify-center whitespace-nowrap rounded border border-red-300 bg-white px-2.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:border-red-800 dark:bg-red-950 dark:text-red-200 dark:hover:bg-red-900"
        data-testid={`invite-revoke-${tokenPrefix}`}
      >
        Revogar
      </button>

      {/*
        Native <dialog>. Tailwind's `backdrop:` variant styles the
        ::backdrop pseudo-element when `showModal()` is used.
      */}
      <dialog
        ref={dialogRef}
        className="rounded-lg border border-neutral-200 bg-white p-6 text-sm shadow-xl backdrop:bg-neutral-900/50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        data-testid={`invite-revoke-dialog-${tokenPrefix}`}
        // `onClose` covers ESC / backdrop-dismiss so transient state
        // (error message, pending) doesn't leak to the next open.
        onClose={() => setError(null)}
      >
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
          Revogar convite?
        </h2>
        <p className="mt-2 text-neutral-700 dark:text-neutral-300">
          Esta ação é irreversível. O prefixo{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-xs dark:bg-neutral-800">
            {tokenPrefix}
          </code>{' '}
          deixará de aceitar redenções imediatamente.
        </p>
        {error ? (
          <p
            className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={closeDialog}
            disabled={isPending}
            className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isPending}
            className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md bg-red-600 px-4 text-sm font-medium text-white shadow transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 disabled:opacity-50"
            data-testid={`invite-revoke-confirm-${tokenPrefix}`}
          >
            {isPending ? 'Revogando…' : 'Revogar'}
          </button>
        </div>
      </dialog>
    </>
  );
};
