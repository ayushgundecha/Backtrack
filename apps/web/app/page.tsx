import { BacktrackProvider } from '@/components/BacktrackProvider';
import { SelectionProvider } from '@/components/SelectionProvider';
import { Shell } from '@/components/Shell';

export default function Page() {
  return (
    <BacktrackProvider tenant="demo">
      <SelectionProvider>
        <Shell />
      </SelectionProvider>
    </BacktrackProvider>
  );
}
