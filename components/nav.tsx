'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

const links = [
  { href: '/', label: 'Visão geral' },
  { href: '/sessions', label: 'Sessões' },
  { href: '/effectiveness', label: 'Efetividade' },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="border-b border-neutral-800 bg-neutral-950">
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-6">
        <span className="font-semibold">TokenFx</span>
        <ul className="flex gap-4">
          {links.map((l) => {
            const active = l.href === '/' ? pathname === '/' : pathname?.startsWith(l.href);
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className={cn(
                    'text-sm text-neutral-400 hover:text-neutral-100 transition',
                    active && 'text-neutral-100 font-medium'
                  )}
                >
                  {l.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
