"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Player from "@/lib/player/playerRuntime";

const MARKS_AT_MS = 60_000;
const BURST_MS = 10_000;
const REACH_MS = 300_000;
/** A seek has landed once the clock is this near its target. */
const LANDED_MS = 2_000;

interface Mark { readonly subject: string; readonly atMs: number; readonly targetMs: number }

/**
 * The return point: one mark, session-local and keyed to a load. A rail or chapter seek of 60s or
 * more marks where it began, once the clock lands on it within 10s: the engine may refuse a seek
 * unseen, and a mark must name a seek that happened. Seeks within 10s of the last keep the first
 * origin. Returning seeks back and, once it lands, swaps the ends; the mark stands until then. A
 * mark retires when the clock crosses it, strays five minutes of media from its target, or the
 * subject changes. Position is read without subscribing, so the owner stays off the clock; the
 * persistent observer reports each tick to `retire`.
 */
export function usePlayerOrigin(subject: string | null) {
  const commands = Player.usePlayerCommands();
  const [mark, setMark] = useState<Mark | null>(null);
  const current = mark !== null && mark.subject === subject ? mark : null;
  const shown = useRef(current);
  shown.current = current;
  /** The marking seek asked last, until the clock lands on it. */
  const asked = useRef<{ readonly mark: Mark; readonly at: number } | null>(null);
  const lastSeek = useRef<{ readonly subject: string; readonly at: number } | null>(null);

  const seek = useCallback((targetMs: number) => {
    if (subject === null) return;
    const fromMs = commands.readPositionMs();
    const now = performance.now();
    const burst = lastSeek.current?.subject === subject && now - lastSeek.current.at < BURST_MS;
    lastSeek.current = { subject, at: now };
    if (!burst) asked.current = null;
    if (Math.abs(targetMs - fromMs) >= MARKS_AT_MS) {
      const kept = burst ? asked.current?.mark ?? shown.current : null;
      asked.current = { mark: { subject, atMs: kept?.atMs ?? fromMs, targetMs }, at: now };
    }
    commands.seekTo({ positionMs: targetMs, expectedSubject: subject });
  }, [commands, subject]);

  const returnToOrigin = useCallback(() => {
    const before = shown.current;
    if (before === null || subject === null) return;
    const now = performance.now();
    lastSeek.current = { subject, at: now };
    asked.current = { mark: { subject, atMs: commands.readPositionMs(), targetMs: before.atMs }, at: now };
    commands.seekTo({ positionMs: before.atMs, expectedSubject: subject });
  }, [commands, subject]);

  const retire = useCallback((positionMs: number) => {
    const pending = asked.current;
    if (pending !== null && Math.abs(positionMs - pending.mark.targetMs) <= LANDED_MS) {
      asked.current = null;
      if (pending.mark.subject === subject && performance.now() - pending.at <= BURST_MS) {
        shown.current = pending.mark;
        setMark(pending.mark);
        return;
      }
    }
    const live = shown.current;
    if (live === null) return;
    const crossed = live.atMs > live.targetMs ? positionMs >= live.atMs : positionMs <= live.atMs;
    if (crossed || Math.abs(positionMs - live.targetMs) >= REACH_MS) {
      shown.current = null;
      setMark(null);
    }
  }, [subject]);

  const atMs = current?.atMs ?? null;
  const targetMs = current?.targetMs ?? null;
  return useMemo(() => ({ origin: atMs === null || targetMs === null ? null : { atMs, targetMs }, seek, returnToOrigin, retire }),
    [atMs, targetMs, seek, returnToOrigin, retire]);
}

export type PlayerOrigin = ReturnType<typeof usePlayerOrigin>;

/** Origin validity follows the provider clock even when workspace visuals unmount. */
export function PlayerOriginObserver({ origin }: { readonly origin: PlayerOrigin }) {
  const { positionMs } = Player.usePlayerTimeline();
  const { retire } = origin;
  useEffect(() => { retire(positionMs); }, [retire, positionMs]);
  return null;
}
