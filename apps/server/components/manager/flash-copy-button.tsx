'use client';

/**
 * Copy-to-clipboard button for the show-once invite URL — REQ-22.
 *
 * Tiny Client Component leaf: takes the URL string and copies it via
 * `navigator.clipboard.writeText`. The page is a Server Component so we
 * can't sprinkle `onClick` directly there — this leaf isolates the only
 * interactive bit.
 *
 * Failure mode: clipboard API can fail (insecure context, denied
 * permission). The URL is selectable in the parent `<code>` block so the
 * user has a manual fallback; we just reset the copied state.
 */
import { useState } from 'react';

type Props = {
  value: string;
};

export const FlashCopyButton = ({ value }: Props) => {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md bg-neutral-900 px-4 text-sm font-medium text-neutral-50 shadow transition-colors hover:bg-neutral-900/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-950 dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-neutral-50/90 dark:focus-visible:ring-neutral-300"
      data-testid="flash-copy-button"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
};
