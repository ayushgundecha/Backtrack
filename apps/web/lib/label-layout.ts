/**
 * Which graph labels to draw so none overlaps another label or a node (BT-049). Greedy, in
 * priority order: the selection and algorithm badges first, lit actions next, then the rest,
 * entities last. A label that does not fit tries its shorter variants (an action falls back to
 * its seq number) and is otherwise skipped; the hover tooltip and the listbox still carry the
 * full text, so dropping a label never drops information. Pure, so it is unit-tested; the canvas
 * passes sizes already converted to graph units for the current zoom.
 */

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LabelCandidate {
  id: string;
  /** Lower goes first. */
  priority: number;
  /** Anchor: the label's top centre. */
  x: number;
  y: number;
  height: number;
  /** Preferred first; each is tried in turn. `y` moves a variant (a label above its node). */
  variants: { text: string; width: number; y?: number }[];
  /** Drawn whatever it overlaps (the selected action, an algorithm's badge, an agent name). */
  always?: boolean;
  /** Obstacles this label may overlap: its own node. */
  ignore?: string;
}

export interface Obstacle extends Rect {
  id: string;
}

export interface PlacedLabel {
  id: string;
  text: string;
  rect: Rect;
}

export const overlaps = (a: Rect, b: Rect) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** Labels to draw, in the order they were placed. Ties in priority keep the input order. */
export function placeLabels(candidates: LabelCandidate[], obstacles: Obstacle[]): PlacedLabel[] {
  const ordered = candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.priority - b.c.priority || a.i - b.i)
    .map(({ c }) => c);
  const placed: PlacedLabel[] = [];
  for (const c of ordered) {
    const options = c.variants.map((v) => ({
      text: v.text,
      rect: {
        x0: c.x - v.width / 2,
        y0: v.y ?? c.y,
        x1: c.x + v.width / 2,
        y1: (v.y ?? c.y) + c.height,
      },
    }));
    // An "always" label ignores nodes and only shortens to stay clear of labels placed before it.
    const fits = (rect: Rect) =>
      !placed.some((p) => overlaps(p.rect, rect)) &&
      (c.always || !obstacles.some((o) => o.id !== c.ignore && overlaps(o, rect)));
    const pick = options.find((o) => fits(o.rect)) ?? (c.always ? options.at(-1) : undefined);
    if (pick) placed.push({ id: c.id, ...pick });
  }
  return placed;
}

/** "order ord_1001" → "ord_1001": an entity's key is enough on the canvas; the tooltip has both. */
export function entityShortLabel(id: string, title: string): string {
  const colon = id.indexOf(':');
  return colon > 0 ? id.slice(colon + 1) : title;
}
