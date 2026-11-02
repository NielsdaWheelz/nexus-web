"use client";

/** A summary read over rows already shown says nothing: it heals on return and on reconnect.
 * It renders nothing, and stays only for callers outside this lane until they stop mounting it. */
export default function MediaSummaryNotice(_props: {
  readonly error: unknown;
  readonly retry: () => void;
  readonly busy?: boolean;
  readonly announcement?: "None" | "Polite" | "Assertive";
  readonly returnFocus?: () => HTMLElement | null;
}) {
  return null;
}
