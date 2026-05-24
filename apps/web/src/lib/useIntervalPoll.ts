"use client";

import { useEffect, useRef } from "react";

/**
 * Run `onPoll` on a fixed interval while `enabled` is true. Reads `onPoll`
 * through a ref so callers don't have to memoize it and the interval only
 * re-installs when `enabled` or `pollIntervalMs` change.
 *
 * Each tick is gated by an in-flight flag so async polls never overlap; the
 * flag clears when the returned promise settles (either resolves or rejects).
 * Sync polls clear it on the next microtask. Errors propagate as unhandled
 * rejections — wrap `onPoll` if you want to swallow them.
 */
export function useIntervalPoll(args: {
  enabled: boolean;
  onPoll: () => void | Promise<void>;
  pollIntervalMs: number;
}): void {
  const { enabled, pollIntervalMs } = args;
  const onPollRef = useRef(args.onPoll);
  onPollRef.current = args.onPoll;

  useEffect(() => {
    if (!enabled || pollIntervalMs <= 0) return;
    let cancelled = false;
    let inFlight = false;
    const tick = () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          await onPollRef.current();
        } finally {
          inFlight = false;
        }
      })();
    };
    const timer = setInterval(tick, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, pollIntervalMs]);
}
