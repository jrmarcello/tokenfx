import Link from 'next/link';
import type { SearchHit as SearchHitType } from '@/lib/search/query';
import { renderSnippet } from '@/lib/search/query';
import { fmtDateTime } from '@/lib/fmt';

export function SearchHit({ hit }: { hit: SearchHitType }) {
  return (
    <Link
      href={`/sessions/${hit.sessionId}#turn-${hit.turnId}`}
      className="block rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 transition hover:border-neutral-600"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
        <div className="flex items-center gap-2">
          <span className="font-medium text-neutral-200">{hit.project}</span>
          <span className="text-neutral-700">•</span>
          <span className="inline-flex size-5 items-center justify-center rounded bg-neutral-800 font-mono text-[10px] text-neutral-300">
            {hit.sequence}
          </span>
          <span className="font-mono text-[11px] text-neutral-500">
            {hit.model}
          </span>
        </div>
        <span className="tabular-nums text-neutral-600">
          {fmtDateTime(hit.timestamp)}
        </span>
      </div>
      {hit.promptSnippet && (
        <p
          className="mt-2 text-sm leading-relaxed text-neutral-300 [&_mark]:rounded-sm [&_mark]:bg-amber-500/20 [&_mark]:px-0.5 [&_mark]:text-amber-200"
          dangerouslySetInnerHTML={renderSnippet(hit.promptSnippet)}
        />
      )}
      {hit.responseSnippet && (
        <p
          className="mt-1 text-sm leading-relaxed text-neutral-400 [&_mark]:rounded-sm [&_mark]:bg-amber-500/20 [&_mark]:px-0.5 [&_mark]:text-amber-200"
          dangerouslySetInnerHTML={renderSnippet(hit.responseSnippet)}
        />
      )}
    </Link>
  );
}
