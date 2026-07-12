'use client';

/**
 * Client leaf for the irreversible Offboard action. The only reason this is a
 * Client Component is the native `window.confirm` guard against a misclick —
 * the real authorization gate is server-side in `offboardUserAction`. The
 * Server Action is passed in as a prop (Next.js supports this).
 */
export function OffboardButton({
  userId,
  email,
  action,
}: {
  userId: string;
  email: string;
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (
          !window.confirm(
            `Offboard ${email}? This anonymizes their identity and revokes all their machines. It cannot be undone.`,
          )
        ) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="userId" value={userId} />
      <button
        type="submit"
        className="rounded border border-red-300 bg-white px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-neutral-800 dark:text-red-300 dark:hover:bg-red-950"
      >
        Offboard
      </button>
    </form>
  );
}
