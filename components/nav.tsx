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
    <nav className="border-b border-neutral-800 bg-neutral-950">
      <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-4">
        <span className="font-semibold">TokenFx</span>
        <ul className="flex gap-4">
          {links.map((l) => {
            const active =
              l.href === '/' ? pathname === '/' : pathname?.startsWith(l.href);
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className={cn(
                    'text-sm text-neutral-400 transition hover:text-neutral-100',
                    active && 'font-medium text-neutral-100',
                  )}
                >
                  {l.label}
                </Link>
              </li>
            );
          })}
        </ul>
        {slot && <div className="ml-auto">{slot}</div>}
      </div>
    </nav>
  );
}
