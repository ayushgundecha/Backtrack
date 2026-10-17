import { notFound } from 'next/navigation';
import { GraphPerf } from '@/components/GraphPerf';

/** A synthetic frame-rate check, served by mock and dev builds only (not by the live demo). */
export default function GraphPerfPage() {
  if (process.env.NEXT_PUBLIC_MOCK !== '1' && process.env.NODE_ENV === 'production') notFound();
  return <GraphPerf />;
}
