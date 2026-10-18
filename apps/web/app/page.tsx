import { BacktrackProvider } from '@/components/BacktrackProvider';
import { ExplainDrawer } from '@/components/ExplainDrawer';
import { SelectionProvider } from '@/components/SelectionProvider';
import { Shell } from '@/components/Shell';
import { tenantFromQuery } from '@/lib/tenant';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const tenant = tenantFromQuery((await searchParams).tenant);
  // Keyed by tenant: another graph is another panel, so the session, selection, plan and any
  // stream of the previous tenant are dropped rather than shown against the wrong graph.
  return (
    <BacktrackProvider key={tenant} tenant={tenant}>
      <SelectionProvider>
        <Shell />
        <ExplainDrawer />
      </SelectionProvider>
    </BacktrackProvider>
  );
}
