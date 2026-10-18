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
  /**
   * The query that produced what the pane shows, as segments: ["GET /api/graph", "9 actions"].
   * Joined with " · " and allowed to wrap only between segments, onto at most two lines, so a
   * long read (a scrubbed world) stays whole instead of being cut mid-word.
   */
  source?: string[] | null;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className={cn('flex min-h-0 flex-col', className)}>
      <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b px-4">
        <h2 id={`${id}-title`} className="shrink-0 font-semibold text-base">
          {title}
        </h2>
        {source && source.length > 0 ? (
          <p className="line-clamp-2 min-w-0 text-right font-mono text-fg-muted text-xs leading-4">
            {source.map((segment, i) => (
              <span key={segment} className="whitespace-nowrap">
                {segment}
                {i < source.length - 1 ? ' · ' : ''}
                {/* A break opportunity after each separator, none inside a segment. */}
                {i < source.length - 1 ? <wbr /> : null}
              </span>
            ))}
          </p>
        ) : null}
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
