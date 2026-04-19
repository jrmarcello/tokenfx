import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="mx-auto max-w-2xl space-y-4 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">
        Página não encontrada
      </h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        O link pode estar quebrado ou a sessão foi removida. Volte pra home
        e tente pela navegação.
      </p>
      <div className="pt-2">
        <Link
          href="/"
          className="inline-block rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 transition-colors hover:border-neutral-400 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:bg-neutral-800"
        >
          Voltar pra home
        </Link>
      </div>
    </section>
  );
}
