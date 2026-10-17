import { cn } from 'cn';

/**
 * One column of the shell: a labelled region with a fixed header and a body that scrolls on its
 * own on desktop (the page scrolls instead when the columns stack on small screens).
 */
export function Pane({
  id,
  title,
  source,
  className,
  children,
}: {
  id: string;
  title: string;
  /** The query that produced what the pane shows, e.g. "GET /api/graph · 9 actions". */
  source?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className={cn('flex min-h-0 flex-col', className)}>
      <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b px-4">
        <h2 id={`${id}-title`} className="font-semibold text-base">
          {title}
        </h2>
        {source ? <p className="truncate font-mono text-fg-muted text-xs">{source}</p> : null}
      </header>
      {children}
    </section>
  );
}

export function PaneBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn('min-h-0 flex-1 p-4 lg:overflow-y-auto', className)}>{children}</div>;
}
