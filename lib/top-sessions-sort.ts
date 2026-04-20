import { z } from 'zod';

// Zod schema compartilhado entre o Server Component (`app/page.tsx`) — que
// parseia `?sort=X` do URL — e o Client Component `TopSessions` — que valida
// o estado do toggle. Mantém-se num módulo puro (sem `'use client'`) porque
// Next.js não expõe valores runtime de módulos client pro servidor.
export const SortModeSchema = z
  .enum(['cost', 'score', 'turns'])
  .catch('cost');

export type SortMode = z.infer<typeof SortModeSchema>;
