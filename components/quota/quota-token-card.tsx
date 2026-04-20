'use client';

import { useRef, useState, useTransition, type JSX, type SVGProps } from 'react';
import { useRouter } from 'next/navigation';
import { fmtCompact, fmtDuration } from '@/lib/fmt';
import { QuotaBar } from '@/components/quota/quota-bar';
import {
  updateQuota5hResetCalibration,
  updateQuota7dResetCalibration,
  updateQuotaSettings,
} from '@/lib/quota/actions';
import type { UpdateQuotaSettingsResult } from '@/lib/quota/actions.core';

type Window = '5h' | '7d';

export type QuotaTokenCardProps = {
  window: Window;
  used: number;
  limit: number | null;
  resetInMs: number | null;
  currentSettings: {
    quotaTokens5h: number | null;
    quotaTokens7d: number | null;
  };
  /** "now" timestamp passed from Server Component to avoid client/server clock skew. */
  now: number;
  /**
   * User's manual calibration timestamp (epoch ms) for this card's window,
   * as entered from Claude.ai's Account & Usage panel. When set, the reset
   * math anchors here and auto-advances (+5h or +7d) once the timestamp
   * passes. Null = heuristic mode.
   */
  calibratedResetAt?: number | null;
};

const WINDOW_LABEL: Record<Window, string> = {
  '5h': 'janela 5h',
  '7d': 'janela 7d',
};

const NO_ACTIVITY_COPY: Record<Window, string> = {
  '5h': 'Sem atividade recente — próxima mensagem inicia bloco',
  '7d': 'Sem atividade nos últimos 7 dias',
};

const CALIBRATION_HINT: Record<Window, string> = {
  '5h':
    'Abra o painel Account & Usage no Claude.ai, leia quando a sessão (5hr) reseta (ex: "Resets 2pm") e informe a data-hora aqui. Deixe em branco pra voltar pra estimativa automática.',
  '7d':
    'Abra o painel Account & Usage no Claude.ai, leia quando a janela Weekly (7 day) reseta (ex: "Resets Apr 22 at 5pm") e informe a data-hora aqui. Deixe em branco pra voltar pra estimativa automática.',
};

/**
 * Convert an epoch-ms timestamp to the `YYYY-MM-DDTHH:mm` format that
 * `<input type="datetime-local">` expects, expressed in the user's local
 * timezone. Returns empty string when `ms` is null.
 */
const toDatetimeLocalValue = (ms: number | null): string => {
  if (ms === null) return '';
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * Parse a `<input type="datetime-local">` value back to epoch-ms. Returns
 * null for empty string (clears the calibration).
 */
const fromDatetimeLocalValue = (v: string): number | null => {
  const trimmed = v.trim();
  if (trimmed === '') return null;
  const ms = new Date(trimmed).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Card for a single Tokens quota window (5h or 7d) on the `/quota` page.
 *
 * Renders usage + threshold + progress bar + reset hint + two edit paths:
 *   1. Pencil button → threshold dialog (both windows).
 *   2. Calibration link → reset-calibration dialog (both windows), scoped
 *      to THIS card's window via `updateQuota{5h,7d}ResetCalibration`.
 *
 * Two visual variants based on `limit`:
 *   - With threshold: big "used / limit" number + QuotaBar + reset line;
 *     pencil icon-only edit button.
 *   - Without threshold: big "used" number + "sem threshold definido" hint;
 *     pencil + "Definir" text button to afford the empty-state action.
 *
 * Save flow uses `useTransition` so buttons and inputs are disabled during
 * the round-trip; on success, `router.refresh()` re-fetches the RSC
 * payload so the card updates with the new values.
 */
export function QuotaTokenCard(props: QuotaTokenCardProps): JSX.Element {
  const {
    window: win,
    used,
    limit,
    resetInMs,
    currentSettings,
    now,
    calibratedResetAt = null,
  } = props;

  const thresholdDialogRef = useRef<HTMLDialogElement | null>(null);
  const thresholdInputRef = useRef<HTMLInputElement | null>(null);
  const calibrationDialogRef = useRef<HTMLDialogElement | null>(null);
  const calibrationInputRef = useRef<HTMLInputElement | null>(null);
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const title = `Tokens — ${WINDOW_LABEL[win]}`;
  const hasThreshold = limit !== null;
  const isCalibrated = calibratedResetAt !== null;

  const openThresholdDialog = (): void => {
    setThresholdError(null);
    thresholdDialogRef.current?.showModal();
  };

  const closeThresholdDialog = (): void => {
    setThresholdError(null);
    thresholdDialogRef.current?.close();
  };

  const openCalibrationDialog = (): void => {
    setCalibrationError(null);
    calibrationDialogRef.current?.showModal();
  };

  const closeCalibrationDialog = (): void => {
    setCalibrationError(null);
    calibrationDialogRef.current?.close();
  };

  const saveThreshold = (): void => {
    setThresholdError(null);
    const raw = thresholdInputRef.current?.value.trim() ?? '';
    const parsed = raw === '' ? null : Number(raw);
    if (parsed !== null && !Number.isFinite(parsed)) {
      setThresholdError('Valor inválido');
      return;
    }
    const payload = {
      quotaTokens5h: win === '5h' ? parsed : currentSettings.quotaTokens5h,
      quotaTokens7d: win === '7d' ? parsed : currentSettings.quotaTokens7d,
    };
    startTransition(async () => {
      const res = await updateQuotaSettings(payload);
      if (res.ok) {
        thresholdDialogRef.current?.close();
        router.refresh();
      } else {
        setThresholdError(res.error.message);
      }
    });
  };

  const saveCalibration = (): void => {
    setCalibrationError(null);
    const raw = calibrationInputRef.current?.value ?? '';
    const parsed = fromDatetimeLocalValue(raw);
    if (raw.trim() !== '' && parsed === null) {
      setCalibrationError('Data inválida');
      return;
    }
    const call = (): Promise<UpdateQuotaSettingsResult> =>
      win === '5h'
        ? updateQuota5hResetCalibration({ quota5hResetAt: parsed })
        : updateQuota7dResetCalibration({ quota7dResetAt: parsed });
    startTransition(async () => {
      const res = await call();
      if (res.ok) {
        calibrationDialogRef.current?.close();
        router.refresh();
      } else {
        setCalibrationError(res.error.message);
      }
    });
  };

  const resetLine = ((): string | null => {
    if (resetInMs !== null) {
      return `Reseta em ~${fmtDuration(resetInMs - now)}`;
    }
    if (hasThreshold) {
      return NO_ACTIVITY_COPY[win];
    }
    return null;
  })();

  return (
    <section
      aria-label={title}
      className="rounded-lg border border-neutral-200 bg-white p-6 transition-colors hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700"
    >
      <header className="flex items-start justify-between gap-4">
        <h3 className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
          {title}
        </h3>
        <button
          type="button"
          onClick={openThresholdDialog}
          aria-label={`Editar threshold ${title}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-700 transition-colors hover:border-emerald-500 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-emerald-500 dark:hover:text-emerald-400"
        >
          <PencilIcon className="size-4" aria-hidden />
          {hasThreshold ? null : <span>Definir</span>}
        </button>
      </header>

      <div className="mt-3">
        <p className="text-4xl font-semibold tabular-nums tracking-tight text-neutral-900 dark:text-neutral-100">
          {hasThreshold ? (
            <>
              {fmtCompact(used)}
              <span className="text-neutral-400 dark:text-neutral-500">
                {' / '}
              </span>
              {fmtCompact(limit)}
            </>
          ) : (
            fmtCompact(used)
          )}
        </p>
        {!hasThreshold ? (
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            sem threshold definido
          </p>
        ) : null}
      </div>

      {hasThreshold ? (
        <div className="mt-4">
          <QuotaBar label={win} used={used} limit={limit} />
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
        {resetLine !== null ? <span>{resetLine}</span> : null}
        <button
          type="button"
          onClick={openCalibrationDialog}
          aria-label={`Calibrar reset da ${WINDOW_LABEL[win]} com Claude.ai`}
          className="inline-flex items-center gap-1 rounded border border-transparent px-1.5 py-0.5 font-medium text-emerald-700 transition-colors hover:border-emerald-500 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
        >
          {isCalibrated ? 'Ajustar calibração' : 'Calibrar com Claude.ai'}
        </button>
      </div>

      <dialog
        ref={thresholdDialogRef}
        onClick={(e) => {
          if (e.target === thresholdDialogRef.current) closeThresholdDialog();
        }}
        // `m-auto` + `fixed inset-0` centraliza no viewport. Necessário
        // porque o preflight do Tailwind v4 zera o `margin: auto` default
        // que o UA aplica ao `<dialog>` aberto via `showModal()`.
        className="fixed inset-0 m-auto max-w-[min(32rem,90vw)] rounded-lg border border-neutral-200 bg-white p-4 text-neutral-900 shadow-lg backdrop:bg-black/40 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <form
          method="dialog"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            saveThreshold();
          }}
          className="flex flex-col gap-3"
        >
          <h2 className="text-base font-semibold">Threshold · {title}</h2>
          <label className="flex flex-col gap-1">
            <input
              ref={thresholdInputRef}
              type="number"
              defaultValue={limit ?? ''}
              min={1}
              max={1_000_000_000}
              step={1}
              autoFocus
              disabled={pending}
              aria-label="Valor em tokens"
              aria-invalid={thresholdError !== null}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm tabular-nums text-neutral-900 focus-visible:border-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            />
            <p className="text-xs text-neutral-500">
              Ex: 500000. Input+output combinados. Vazio = remover threshold.
            </p>
          </label>
          {thresholdError !== null ? (
            <p role="alert" className="text-xs text-red-600">
              {thresholdError}
            </p>
          ) : null}
          <div className="mt-1 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={closeThresholdDialog}
              className="rounded-md border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={pending}
              className="rounded-md border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </form>
      </dialog>

      <dialog
        ref={calibrationDialogRef}
        onClick={(e) => {
          if (e.target === calibrationDialogRef.current)
            closeCalibrationDialog();
        }}
        className="fixed inset-0 m-auto max-w-[min(32rem,90vw)] rounded-lg border border-neutral-200 bg-white p-4 text-neutral-900 shadow-lg backdrop:bg-black/40 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <form
          method="dialog"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            saveCalibration();
          }}
          className="flex flex-col gap-3"
        >
          <h2 className="text-base font-semibold">
            Calibrar reset · {WINDOW_LABEL[win]}
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {CALIBRATION_HINT[win]}
          </p>
          <label className="flex flex-col gap-1">
            <input
              ref={calibrationInputRef}
              type="datetime-local"
              defaultValue={toDatetimeLocalValue(calibratedResetAt)}
              autoFocus
              disabled={pending}
              aria-label={`Data e hora do próximo reset ${win}`}
              aria-invalid={calibrationError !== null}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus-visible:border-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            />
          </label>
          {calibrationError !== null ? (
            <p role="alert" className="text-xs text-red-600">
              {calibrationError}
            </p>
          ) : null}
          <div className="mt-1 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={closeCalibrationDialog}
              className="rounded-md border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={pending}
              className="rounded-md border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}

const PencilIcon = (props: SVGProps<SVGSVGElement>): JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <path d="M17 3l4 4-12 12H5v-4L17 3z" />
  </svg>
);
