/**
 * `/manager/check-in/[devId]` — drilldown reached from the proactive
 * "check-in opportunity" CTA on the manager overview (REQ-14, REQ-15,
 * REQ-16). Logic is shared with `/manager/devs/[devId]` via
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

export default async function CheckInDrilldownPage({
  params,
  searchParams,
}: PageProps) {
  const { devId } = await params;
  const sp = await searchParams;
  const data = await loadDrilldownData(devId, sp, {
    sourceRoute: '/manager/check-in/[devId]',
  });
  return renderDrilldown(data);
}
