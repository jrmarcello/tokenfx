'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

type DaysOption = { label: string; value: string };

const DAYS_OPTIONS: readonly DaysOption[] = [
  { label: 'todas', value: '' },
  { label: '7d', value: '7' },
  { label: '30d', value: '30' },
  { label: '90d', value: '90' },
];

export function SearchForm({
  initialQuery,
  initialDays,
}: {
  initialQuery: string;
  initialDays: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(initialQuery);
  const [days, setDays] = useState(initialDays);
  const [pending, startTransition] = useTransition();

  const submit = (nextQ: string, nextDays: string) => {
    const sp = new URLSearchParams(params?.toString() ?? '');
    if (nextQ.trim().length > 0) sp.set('q', nextQ.trim());
    else sp.delete('q');
    if (nextDays) sp.set('days', nextDays);
    else sp.delete('days');
    // Reset pagination on new search.
    sp.delete('offset');
    startTransition(() => {
      router.push(`/search${sp.toString() ? `?${sp.toString()}` : ''}`);
    });
  };

  return (
    <form
      method="GET"
      action="/search"
      onSubmit={(e) => {
        e.preventDefault();
        submit(q, days);
      }}
      className="flex flex-wrap items-end gap-3"
    >
      <label className="flex-1 min-w-[16rem]">
        <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">
          Consulta
        </span>
        <input
          type="search"
          name="q"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Busque no transcript (ex: auth bug)"
          maxLength={200}
          autoFocus
          className="w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-600"
        />
      </label>
      <label>
        <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">
          Janela
        </span>
        <select
          name="days"
          value={days}
          onChange={(e) => {
            setDays(e.target.value);
            submit(q, e.target.value);
          }}
          className="rounded border border-neutral-800 bg-neutral-950 px-2 py-2 text-sm text-neutral-100"
        >
          {DAYS_OPTIONS.map((o) => (
            <option key={o.label} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-neutral-700 bg-neutral-800 px-4 py-2 text-sm text-neutral-100 transition hover:bg-neutral-700 disabled:opacity-50"
      >
        {pending ? 'Buscando…' : 'Buscar'}
      </button>
    </form>
  );
}
