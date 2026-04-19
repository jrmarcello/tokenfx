'use client';

import * as React from 'react';
import { useState, useTransition } from 'react';
import { updateQuotaSettings } from '@/lib/quota/actions';

export type QuotaFormProps = {
  initial: {
    quotaTokens5h: number | null;
    quotaTokens7d: number | null;
    quotaSessions5h: number | null;
    quotaSessions7d: number | null;
  };
};

type FieldKey =
  | 'quotaTokens5h'
  | 'quotaTokens7d'
  | 'quotaSessions5h'
  | 'quotaSessions7d';

type FieldInputs = Record<FieldKey, string>;

type FieldSpec = {
  key: FieldKey;
  label: string;
  help: string;
  max: number;
};

const FIELDS: readonly FieldSpec[] = [
  {
    key: 'quotaTokens5h',
    label: 'Tokens — janela 5h',
    help: 'Ex: 500000. Input + output combinados (sem cache). Deixe em branco pra não rastrear.',
    max: 1_000_000_000,
  },
  {
    key: 'quotaTokens7d',
    label: 'Tokens — janela 7d',
    help: 'Cap semanal em tokens. Deixe em branco pra não rastrear.',
    max: 1_000_000_000,
  },
  {
    key: 'quotaSessions5h',
    label: 'Sessões — janela 5h',
    help: 'Número de sessões iniciadas nas últimas 5h. Deixe em branco pra não rastrear.',
    max: 10_000,
  },
  {
    key: 'quotaSessions7d',
    label: 'Sessões — janela 7d',
    help: 'Cap semanal em sessões. Deixe em branco pra não rastrear.',
    max: 10_000,
  },
] as const;

type Status =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'success' }
  | { kind: 'error'; message: string; field?: string };

const numberOrEmpty = (n: number | null): string =>
  n === null ? '' : String(n);

const emptyOrNumber = (s: string): number | null => {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export function QuotaForm({ initial }: QuotaFormProps): React.JSX.Element {
  const [inputs, setInputs] = useState<FieldInputs>({
    quotaTokens5h: numberOrEmpty(initial.quotaTokens5h),
    quotaTokens7d: numberOrEmpty(initial.quotaTokens7d),
    quotaSessions5h: numberOrEmpty(initial.quotaSessions5h),
    quotaSessions7d: numberOrEmpty(initial.quotaSessions7d),
  });
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [, startTransition] = useTransition();

  const onSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    setStatus({ kind: 'saving' });
    const payload = {
      quotaTokens5h: emptyOrNumber(inputs.quotaTokens5h),
      quotaTokens7d: emptyOrNumber(inputs.quotaTokens7d),
      quotaSessions5h: emptyOrNumber(inputs.quotaSessions5h),
      quotaSessions7d: emptyOrNumber(inputs.quotaSessions7d),
    };
    startTransition(async () => {
      const res = await updateQuotaSettings(payload);
      if (res.ok) {
        setStatus({ kind: 'success' });
      } else {
        setStatus({
          kind: 'error',
          message: res.error.message,
          field: res.error.field,
        });
      }
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {FIELDS.map((f) => {
          const fieldError =
            status.kind === 'error' && status.field === f.key
              ? status.message
              : null;
          return (
            <label key={f.key} className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-neutral-800 dark:text-neutral-200">{f.label}</span>
              <input
                type="number"
                min={1}
                max={f.max}
                step={1}
                value={inputs[f.key]}
                onChange={(e) =>
                  setInputs((prev) => ({ ...prev, [f.key]: e.target.value }))
                }
                aria-label={f.label}
                aria-invalid={fieldError !== null}
                placeholder="vazio = não rastrear"
                className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-neutral-900 dark:text-neutral-100 focus:border-neutral-500 focus:outline-none"
              />
              <span className="text-xs text-neutral-500">{f.help}</span>
              {fieldError && (
                <span className="text-xs text-red-600 dark:text-red-400" role="alert">
                  Erro: {fieldError}
                </span>
              )}
            </label>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={status.kind === 'saving'}
          className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm hover:border-neutral-500 disabled:opacity-50"
        >
          {status.kind === 'saving' ? 'Salvando…' : 'Salvar'}
        </button>
        {status.kind === 'success' && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">Salvo!</span>
        )}
        {status.kind === 'error' && !status.field && (
          <span className="text-xs text-red-600 dark:text-red-400" role="alert">
            Erro: {status.message}
          </span>
        )}
      </div>
    </form>
  );
}
