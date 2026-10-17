import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';

/**
 * Status color is meaning, not decoration: amber = waiting on a human, red = irreversible or
 * refused, green = reverted or succeeded, dashed grey = undone. Everything else stays neutral.
 */
const tone: Record<string, string> = {
  pending: 'border-amber/60 text-amber',
  paused: 'border-amber/60 text-amber',
  running: 'border-accent/60 text-accent',
  undone: 'border-dashed border-grey-node text-fg-muted',
  blocked: 'border-red/60 text-red',
  denied: 'border-red/60 text-red',
  failed: 'border-red/60 text-red',
  conflict: 'border-red/60 text-red',
  approved: 'border-green/60 text-green',
  executed: 'border-green/60 text-green',
};

const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn('border-border font-normal text-fg-muted', tone[status], className)}
    >
      {sentenceCase(status)}
    </Badge>
  );
}
