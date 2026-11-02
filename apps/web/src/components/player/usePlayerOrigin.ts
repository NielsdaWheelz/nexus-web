"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import * as Player from "@/lib/player/playerRuntime";

const MARKS_AT_MS = 60_000;
const BURST_MS = 10_000;
const REACH_MS = 300_000;
/** A seek has landed once the clock is this near its target; until then the old position stands. */
const LANDED_MS = 2_000;

interface Mark { readonly subject: string; readonly atMs: number; readonly targetMs: number }

/**
 * The return point: one mark, session-local and keyed to a load. A rail or chapter seek of 60s or
 * more marks where it began; seeks within 10s of the last keep the first origin. Returning seeks
 * back and swaps the ends. A landed mark retires when the clock crosses it, strays five minutes
 * of media from its target, or the subject changes. Position is read without subscribing, so the
 * owner stays off the clock; the rule reports each tick to `retire`.
 */
export function usePlayerOrigin(subject: string | null) {
  const commands = Player.usePlayerCommands();
  const [mark, setMark] = useState<Mark | null>(null);
  const current = mark !== null && mark.subject === subject ? mark : null;
  const latest = useRef(current);
  latest.current = current;
  const lastSeek = useRef<{ readonly subject: string; readonly at: number } | null>(null);
  const landed = useRef<Mark | null>(null);

  const seek = useCallback((targetMs: number) => {
    if (subject === null) return;
    const fromMs = commands.readPositionMs();
    const now = performance.now();
    const burst = lastSeek.current?.subject === subject && now - lastSeek.current.at < BURST_MS;
    lastSeek.current = { subject, at: now };
    if (Math.abs(targetMs - fromMs) >= MARKS_AT_MS) {
      const kept = burst ? latest.current : null;
      setMark({ subject, atMs: kept?.atMs ?? fromMs, targetMs });
    }
    commands.seekTo({ positionMs: targetMs, expectedSubject: subject });
  }, [commands, subject]);

  const returnToOrigin = useCallback(() => {
    const before = latest.current;
    if (before === null || subject === null) return;
    lastSeek.current = { subject, at: performance.now() };
    setMark({ subject, atMs: commands.readPositionMs(), targetMs: before.atMs });
    commands.seekTo({ positionMs: before.atMs, expectedSubject: subject });
  }, [commands, subject]);

  const retire = useCallback((positionMs: number) => {
    const live = latest.current;
    if (live === null) return;
    if (landed.current !== live) {
      if (Math.abs(positionMs - live.targetMs) <= LANDED_MS) landed.current = live;
      return;
    }
    const crossed = live.atMs > live.targetMs ? positionMs >= live.atMs : positionMs <= live.atMs;
    if (crossed || Math.abs(positionMs - live.targetMs) >= REACH_MS) setMark(null);
  }, []);

  const atMs = current?.atMs ?? null;
  const targetMs = current?.targetMs ?? null;
  return useMemo(() => ({ origin: atMs === null || targetMs === null ? null : { atMs, targetMs }, seek, returnToOrigin, retire }),
    [atMs, targetMs, seek, returnToOrigin, retire]);
}

export type PlayerOrigin = ReturnType<typeof usePlayerOrigin>;
