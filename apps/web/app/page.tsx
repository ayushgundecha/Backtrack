import { BacktrackProvider } from '@/components/BacktrackProvider';
import { ExplainDrawer } from '@/components/ExplainDrawer';
import { SelectionProvider } from '@/components/SelectionProvider';
import { Shell } from '@/components/Shell';
import { TimeProvider } from '@/components/TimeProvider';

export default function Page() {
  return (
    <BacktrackProvider tenant="demo">
      <SelectionProvider>
        <TimeProvider>
          <Shell />
          <ExplainDrawer />
        </TimeProvider>
      </SelectionProvider>
    </BacktrackProvider>
  );
}
