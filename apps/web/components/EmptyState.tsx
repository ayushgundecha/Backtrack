import { CircleAlert, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function EmptyState({
  title,
  children,
}: {
  title: string;
  /** The action that ends the emptiness, e.g. a "Run ops agent" button. */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed px-4 py-6">
      <p className="text-fg-muted">{title}</p>
      {children}
    </div>
  );
}

/**
 * A pane whose first read failed: what could not be read, the route's own message, and a way to
 * ask again. Shown instead of a skeleton that would otherwise wait forever.
 */
export function ErrorState({
  title,
  message,
  onRetry,
  announce = true,
}: {
  title: string;
  message: string;
  onRetry: () => void;
  /** One alert per failure: a second pane showing the same failed read passes false. */
  announce?: boolean;
}) {
  return (
    <div
      role={announce ? 'alert' : undefined}
      className="flex flex-col items-start gap-3 rounded-lg border border-red/50 px-4 py-6"
    >
      <p className="flex items-center gap-2 font-medium">
        <CircleAlert aria-hidden className="size-4 shrink-0 text-red" />
        {title}
      </p>
      <p className="break-words font-mono text-code text-fg-muted">{message}</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        <RotateCw aria-hidden />
        Try again
      </Button>
    </div>
  );
}
