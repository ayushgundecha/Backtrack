import { BacktrackProvider } from '@/components/BacktrackProvider';
import { Shell } from '@/components/Shell';

export default function Page() {
  return (
    <BacktrackProvider tenant="demo">
      <Shell />
    </BacktrackProvider>
  );
}
