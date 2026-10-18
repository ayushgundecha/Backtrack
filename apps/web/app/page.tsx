import { BacktrackProvider } from '@/components/BacktrackProvider';
import { ExplainDrawer } from '@/components/ExplainDrawer';
import { SelectionProvider } from '@/components/SelectionProvider';
import { Shell } from '@/components/Shell';

export default function Page() {
  return (
    <BacktrackProvider tenant="demo">
      <SelectionProvider>
        <Shell />
        <ExplainDrawer />
      </SelectionProvider>
    </BacktrackProvider>
  );
}
