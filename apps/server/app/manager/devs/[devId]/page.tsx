/**
 * `/manager/devs/[devId]` — drilldown reached from manual navigation
 * or from the team-roster table (REQ-14, REQ-15, REQ-16). Logic is
 * shared with `/manager/check-in/[devId]` via
 * `app/manager/_drilldown/render.tsx`; the only difference is the
 * `sourceRoute` attribution recorded on the audit row.
 */
import {
  loadDrilldownData,
  renderDrilldown,
} from '@/app/manager/_drilldown/render';

type PageProps = {
  params: Promise<{ devId: string }>;
  searchParams: Promise<{ reason?: string; reasonText?: string }>;
};

export default async function DevDrilldownPage({
  params,
  searchParams,
}: PageProps) {
  const { devId } = await params;
  const sp = await searchParams;
  const data = await loadDrilldownData(devId, sp, {
    sourceRoute: '/manager/devs/[devId]',
  });
  return renderDrilldown(data);
}
