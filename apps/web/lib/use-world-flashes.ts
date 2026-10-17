'use client';

import type { WorldSnapshot } from '@backtrack/core/contracts';
import { useEffect, useRef, useState } from 'react';
import type { SessionState } from './session';
import { diffWorld, type FieldFlash, isEmptyDiff, isRevert, undoProgress } from './world-diff';

/** docs/design-system.md: a change flashes for 600 ms; a revert says "restored" for 2 s. */
export const FLASH_MS: Record<FieldFlash, number> = { changed: 600, restored: 2000 };

export interface ActiveFlash {
  kind: FieldFlash;
  /** Bumps on every new flash so the element re-mounts and its animation restarts. */
  token: number;
}

/** entity id → field → the flash currently showing on it. */
export type Flashes = Record<string, Record<string, ActiveFlash>>;

/**
 * Turns successive world reads into short-lived field flashes. The previous read and the undo
 * progress at that read are kept in refs; each new read is diffed against them.
 */
export function useWorldFlashes(world: WorldSnapshot | null, session: SessionState): Flashes {
  const [flashes, setFlashes] = useState<Flashes>({});
  const previous = useRef<WorldSnapshot | null>(null);
  const previousProgress = useRef(undoProgress(session));
  const counter = useRef(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    if (!world) return;
    const progress = undoProgress(sessionRef.current);
    const diff = diffWorld(previous.current, world, isRevert(previousProgress.current, progress));
    previous.current = world;
    previousProgress.current = progress;
    if (!diff || isEmptyDiff(diff)) return;

    const added: Flashes = {};
    const timers: { entity: string; field: string; token: number; kind: FieldFlash }[] = [];
    for (const [entity, fields] of Object.entries(diff.fields)) {
      added[entity] = {};
      for (const [field, kind] of Object.entries(fields)) {
        const token = ++counter.current;
        added[entity][field] = { kind, token };
        timers.push({ entity, field, token, kind });
      }
    }
    setFlashes((current) => {
      const next = { ...current };
      for (const [entity, fields] of Object.entries(added)) {
        next[entity] = { ...next[entity], ...fields };
      }
      return next;
    });
    // Each flash clears itself unless a newer one replaced it in the meantime.
    for (const { entity, field, token, kind } of timers) {
      setTimeout(() => {
        setFlashes((current) => {
          if (current[entity]?.[field]?.token !== token) return current;
          const { [field]: _gone, ...rest } = current[entity] ?? {};
          const next = { ...current };
          if (Object.keys(rest).length > 0) next[entity] = rest;
          else delete next[entity];
          return next;
        });
      }, FLASH_MS[kind]);
    }
  }, [world]);

  return flashes;
}
