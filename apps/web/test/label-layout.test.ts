/**
 * Graph labels never overlap (BT-049): the greedy placement keeps the highest-priority labels,
 * shortens an action to its seq number when crowded, keeps "always" labels, and stays clear of
 * other nodes.
 */
import { describe, expect, it } from 'vitest';
import { entityShortLabel, type LabelCandidate, overlaps, placeLabels } from '../lib/label-layout';

const label = (id: string, x: number, y: number, priority: number, ...texts: string[]) =>
  ({
    id,
    priority,
    x,
    y,
    height: 10,
    variants: texts.map((text) => ({ text, width: text.length * 6 })),
    ignore: id,
  }) satisfies LabelCandidate;

describe('placeLabels', () => {
  it('draws every label when nothing collides', () => {
    const placed = placeLabels(
      [label('a', 0, 0, 1, 'update_address'), label('b', 0, 40, 1, 'create_ticket')],
      [],
    );
    expect(placed.map((p) => p.text)).toEqual(['update_address', 'create_ticket']);
  });

  it('keeps the higher priority label and shortens the other to its seq number', () => {
    const placed = placeLabels(
      [
        label('low', 10, 0, 5, '3 create_ticket', '3'),
        label('high', 0, 0, 1, '2 update_address', '2'),
      ],
      [],
    );
    const byId = Object.fromEntries(placed.map((p) => [p.id, p.text]));
    expect(byId.high).toBe('2 update_address');
    // The short variant sits at x 10 ± 3, still inside the long label (x −48…48): dropped.
    expect(byId.low).toBeUndefined();

    const apart = placeLabels(
      [label('low', 60, 0, 5, '3 create_ticket', '3'), label('high', 0, 0, 1, '2 update_address')],
      [],
    );
    expect(Object.fromEntries(apart.map((p) => [p.id, p.text]))).toEqual({
      high: '2 update_address',
      low: '3',
    });
  });

  it('never returns two overlapping labels', () => {
    const crowd = Array.from({ length: 30 }, (_, i) =>
      label(`n${i}`, (i % 6) * 20, Math.floor(i / 6) * 8, i % 3, `${i} some_tool_name`, String(i)),
    );
    const placed = placeLabels(crowd, []);
    for (const [i, a] of placed.entries()) {
      for (const b of placed.slice(i + 1)) expect(overlaps(a.rect, b.rect)).toBe(false);
    }
    expect(placed.length).toBeGreaterThan(0);
  });

  it('keeps labels off other nodes but not off their own', () => {
    const obstacles = [
      { id: 'a', x0: -6, y0: -12, x1: 6, y1: -1 },
      { id: 'b', x0: -6, y0: 4, x1: 6, y1: 14 },
    ];
    const placed = placeLabels([label('a', 0, 0, 1, 'lookup_order')], obstacles);
    expect(placed).toEqual([]);
    const own = placeLabels([label('a', 0, 0, 1, 'lookup_order')], obstacles.slice(0, 1));
    expect(own.map((p) => p.text)).toEqual(['lookup_order']);
  });

  it('moves a label above its node when below is taken', () => {
    const agent = { ...label('agent', 0, 12, 1, 'Billing agent'), always: true };
    const action: LabelCandidate = {
      ...label('a', 0, 12, 2, '6 schedule_followup'),
      variants: [
        { text: '6 schedule_followup', width: 114 },
        { text: '6 schedule_followup', width: 114, y: -20 },
      ],
    };
    const placed = placeLabels([agent, action], []);
    expect(placed.find((p) => p.id === 'a')?.rect.y0).toBe(-20);
  });

  it('always draws a label marked always, ignoring nodes', () => {
    const selected = { ...label('sel', 0, 0, 0, '2 update_address', '2'), always: true };
    const placed = placeLabels([selected], [{ id: 'x', x0: -5, y0: 0, x1: 5, y1: 10 }]);
    expect(placed.map((p) => p.text)).toEqual(['2 update_address']);
  });
});

describe('entityShortLabel', () => {
  it('shows the key of a typed id and falls back to the title', () => {
    expect(entityShortLabel('order:ord_1001', 'order ord_1001')).toBe('ord_1001');
    expect(entityShortLabel('entity 3', 'entity 3')).toBe('entity 3');
  });
});
