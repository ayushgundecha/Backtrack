'use client';

/**
 * The time scrubber under the world panel (PLAN §7.3): one stop per recorded action, one before
 * the first, and now. Each stop asks GET /api/world?asOfSeq=N, which rolls back every later Effect
 * by its `before`; the world panel shows that frame and the graph dims what came after N. Nothing
 * is written: "Now" just goes back to the live read. No animation of its own, so reduced motion
 * has nothing to turn off here (the world panel's flashes follow their own reduced-motion rule).
 */
import { cn } from 'cn';
import { History, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { stopLabel } from '@/lib/time-travel';
import { familyDotClass, familyOf } from '@/lib/tools';
import { useTime } from './TimeProvider';

const isUndoSide = (kind: string | null) => kind === 'undo' || kind === 'mitigation';

// Thumb is 12 px wide and Radix keeps it inside the track, so stop i sits at
// 6 px + i / (n - 1) of the remaining width; ticks use the same inset to line up with it.
const tickLeft = (i: number, n: number) => `calc(6px + (100% - 12px) * ${n > 1 ? i / (n - 1) : 0})`;

export function TimeScrubber() {
  const { stops, index, asOfSeq, status, error, scrubTo } = useTime();
  const current = stops[index] ?? stops[stops.length - 1];
  const actionCount = stops.filter((s) => s.kind === 'action').length;

  if (actionCount === 0) {
    return (
      <p className="flex items-center gap-2 text-fg-muted text-sm">
        <History aria-hidden className="size-4 shrink-0" />
        Time scrubber: one stop per action once something is recorded.
      </p>
    );
  }

  const later = stops.filter(
    (s) => s.kind === 'action' && asOfSeq !== null && s.action.seq > asOfSeq,
  ).length;

  return (
    <section aria-labelledby="time-title" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 id="time-title" className="flex shrink-0 items-center gap-1.5 text-fg-muted text-xs">
          <History aria-hidden className="size-3.5" />
          Time
        </h3>
        <p
          aria-live="polite"
          className={cn(
            'min-w-0 truncate font-mono text-xs',
            asOfSeq === null ? 'text-fg-muted' : 'text-fg',
          )}
        >
          {asOfSeq === null || !current ? 'Live world' : stopLabel(current)}
        </p>
        {status === 'loading' ? (
          <LoaderCircle
            aria-label="Reading the world at that point"
            className="size-3.5 shrink-0 animate-spin text-fg-muted motion-reduce:animate-none"
          />
        ) : null}
        <Button
          variant="secondary"
          size="xs"
          className="ml-auto"
          disabled={asOfSeq === null}
          onClick={() => scrubTo(null)}
        >
          Now
        </Button>
      </div>

      <div className="relative pb-2.5">
        <Slider
          min={0}
          max={stops.length - 1}
          step={1}
          value={[index]}
          onValueChange={([v]) => {
            const stop = v === undefined ? undefined : stops[v];
            if (stop) scrubTo(stop.asOfSeq);
          }}
          thumbProps={{
            'aria-label': 'Time: the world right after an action',
            'aria-valuetext':
              asOfSeq === null || !current ? 'Now, the live world' : stopLabel(current),
          }}
          className="py-1.5"
        />
        {/* One tick per action, in its tool family's color; later ones fade with the graph. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-2">
          {stops.map((stop, i) =>
            stop.kind === 'action' ? (
              <span
                key={stop.action.id}
                className={cn(
                  'absolute top-0 h-2 w-0.5 -translate-x-1/2 rounded-full',
                  isUndoSide(stop.action.kind)
                    ? 'bg-green'
                    : familyDotClass[familyOf(stop.action.tool)],
                  i > index && 'opacity-30',
                )}
                style={{ left: tickLeft(i, stops.length) }}
              />
            ) : null,
          )}
        </div>
      </div>

      {status === 'error' ? (
        <p className="text-red text-xs">{error}</p>
      ) : (
        <p className="font-mono text-fg-muted text-xs">
          {asOfSeq === null
            ? `${actionCount} actions recorded · drag back to see the world after any of them`
            : `GET /api/world?asOfSeq=${asOfSeq} · ${later} later ${later === 1 ? 'action' : 'actions'} dimmed`}
        </p>
      )}
    </section>
  );
}
