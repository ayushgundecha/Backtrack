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
