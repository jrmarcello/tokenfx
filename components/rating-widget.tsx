'use client';
import { useState, useTransition } from 'react';
import { cn } from '@/lib/cn';

type Value = -1 | 0 | 1;

export function RatingWidget({
  turnId,
  initial,
}: {
  turnId: string;
  // `null` = turn has no rating row yet. `Value` = user-persisted rating.
  // Distinguishing the two keeps "Neutro" from looking preselected on
  // unrated turns.
  initial: Value | null;
}) {
  const [value, setValue] = useState<Value | null>(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function setRating(next: Value) {
    setValue(next);
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/ratings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ turnId, rating: next }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch {
        setValue(initial);
        setError('Falha ao salvar avaliação');
      }
    });
  }

  const base = 'text-xs px-2 py-1 rounded border transition';
  return (
    <div className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400 print:hidden">
      <span>Avaliação:</span>
      <button
        className={cn(
          base,
          value === 1
            ? 'border-emerald-500 text-emerald-700 dark:text-emerald-300 bg-emerald-950/40'
            : 'border-neutral-300 dark:border-neutral-700 hover:border-neutral-500'
        )}
        onClick={() => setRating(1)}
        disabled={pending}
        aria-pressed={value === 1}
      >
        Bom
      </button>
      <button
        className={cn(
          base,
          value === 0
            ? 'border-neutral-400 text-neutral-800 dark:text-neutral-200 bg-neutral-100 dark:bg-neutral-800'
            : 'border-neutral-300 dark:border-neutral-700 hover:border-neutral-500'
        )}
        onClick={() => setRating(0)}
        disabled={pending}
        aria-pressed={value === 0}
      >
        Neutro
      </button>
      <button
        className={cn(
          base,
          value === -1
            ? 'border-red-500 text-red-700 dark:text-red-300 bg-red-950/40'
            : 'border-neutral-300 dark:border-neutral-700 hover:border-neutral-500'
        )}
        onClick={() => setRating(-1)}
        disabled={pending}
        aria-pressed={value === -1}
      >
        Ruim
      </button>
      {error && <span className="text-red-600 dark:text-red-400">{error}</span>}
    </div>
  );
}
