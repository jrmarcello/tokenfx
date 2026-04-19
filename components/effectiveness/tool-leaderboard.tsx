import { Card, CardContent } from '@/components/ui/card';
import type { ToolLeaderboardItem } from '@/lib/queries/effectiveness';

export function ToolLeaderboard({ items }: { items: ToolLeaderboardItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-neutral-500 text-sm">Nenhuma chamada de ferramenta registrada.</p>
    );
  }
  return (
    <Card className="bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-800">
      <CardContent className="p-0">
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {items.map((t) => (
            <li
              key={t.toolName}
              className="flex items-center justify-between px-4 py-2 text-sm"
            >
              <span className="font-medium">{t.toolName}</span>
              <div className="flex items-center gap-6 tabular-nums text-neutral-600 dark:text-neutral-400">
                <span>{t.count} chamadas</span>
                {t.errorCount > 0 && (
                  <span className="text-red-600 dark:text-red-400">{t.errorCount} erros</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
