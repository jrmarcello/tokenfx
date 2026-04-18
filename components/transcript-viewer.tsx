import type { TurnDetail } from '@/lib/queries/session';
import { RatingWidget } from '@/components/rating-widget';

function fmtUsd(n: number) {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 4,
  });
}
function fmtNum(n: number) {
  return n.toLocaleString();
}
function fmtTime(ms: number) {
  return new Date(ms).toLocaleTimeString();
}

export function TranscriptViewer({ turns }: { turns: TurnDetail[] }) {
  if (turns.length === 0) {
    return (
      <p className="text-neutral-500 text-sm">No turns in this session.</p>
    );
  }
  return (
    <ol className="space-y-4">
      {turns.map((t) => (
        <li
          key={t.id}
          className="rounded-lg border border-neutral-800 bg-neutral-900 overflow-hidden"
        >
          <header className="flex items-center justify-between px-4 py-2 border-b border-neutral-800 text-xs text-neutral-400 bg-neutral-900/60">
            <div className="flex items-center gap-3">
              <span className="font-medium text-neutral-200">#{t.sequence}</span>
              <span>{t.model}</span>
              <span>{fmtTime(t.timestamp)}</span>
            </div>
            <div className="flex items-center gap-4 tabular-nums">
              <span>{fmtUsd(t.costUsd)}</span>
              <span>
                {fmtNum(t.inputTokens)} in / {fmtNum(t.outputTokens)} out /{' '}
                {fmtNum(t.cacheReadTokens)} cache
              </span>
            </div>
          </header>
          <div className="p-4 space-y-3 text-sm">
            {t.userPrompt && (
              <div>
                <div className="text-xs text-neutral-500 mb-1">User</div>
                <pre className="whitespace-pre-wrap rounded bg-neutral-950 border border-neutral-800 p-3 text-neutral-200">
                  {t.userPrompt}
                </pre>
              </div>
            )}
            {t.assistantText && (
              <div>
                <div className="text-xs text-neutral-500 mb-1">Assistant</div>
                <pre className="whitespace-pre-wrap rounded bg-neutral-950 border border-neutral-800 p-3 text-neutral-100">
                  {t.assistantText}
                </pre>
              </div>
            )}
            {t.toolCalls.length > 0 && (
              <div>
                <div className="text-xs text-neutral-500 mb-1">Tool calls</div>
                <ul className="space-y-2">
                  {t.toolCalls.map((tc) => (
                    <li
                      key={tc.id}
                      className={
                        tc.resultIsError
                          ? 'border-l-2 border-red-500 pl-3'
                          : 'border-l-2 border-neutral-700 pl-3'
                      }
                    >
                      <details>
                        <summary className="cursor-pointer text-neutral-300 hover:text-neutral-100">
                          {tc.toolName}
                        </summary>
                        <div className="mt-2 space-y-2">
                          <div>
                            <div className="text-xs text-neutral-500">Input</div>
                            <pre className="whitespace-pre-wrap text-xs bg-neutral-950 border border-neutral-800 rounded p-2">
                              {tc.inputJson}
                            </pre>
                          </div>
                          {tc.resultJson !== null && (
                            <div>
                              <div className="text-xs text-neutral-500">
                                Result{' '}
                                {tc.resultIsError && (
                                  <span className="text-red-400">(error)</span>
                                )}
                              </div>
                              <pre className="whitespace-pre-wrap text-xs bg-neutral-950 border border-neutral-800 rounded p-2">
                                {tc.resultJson}
                              </pre>
                            </div>
                          )}
                        </div>
                      </details>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="pt-2 border-t border-neutral-800">
              <RatingWidget turnId={t.id} initial={t.rating?.value ?? 0} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
