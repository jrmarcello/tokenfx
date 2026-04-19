'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

const links = [
  { href: '/', label: 'Visão geral' },
  { href: '/sessions', label: 'Sessões' },
  { href: '/effectiveness', label: 'Efetividade' },
  { href: '/quota', label: 'Quota' },
  { href: '/search', label: 'Busca' },
];

export function Nav({ slot }: { slot?: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <nav className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:gap-6 sm:px-6 sm:py-4">
        <span className="shrink-0 font-semibold">TokenFx</span>
        <ul className="flex min-w-0 flex-1 gap-3 overflow-x-auto sm:gap-4">
          {links.map((l) => {
            const active =
              l.href === '/' ? pathname === '/' : pathname?.startsWith(l.href);
            return (
              <li key={l.href} className="shrink-0">
                <Link
                  href={l.href}
                  className={cn(
                    'whitespace-nowrap text-sm text-neutral-600 dark:text-neutral-400 transition hover:text-neutral-900 dark:hover:text-neutral-100',
                    active && 'font-medium text-neutral-900 dark:text-neutral-100',
                  )}
                >
                  {l.label}
                </Link>
              </li>
            );
          })}
        </ul>
        {slot && <div className="ml-auto shrink-0">{slot}</div>}
      </div>
    </nav>
  );
}
