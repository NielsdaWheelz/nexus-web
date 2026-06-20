/**
 * PerRunStreamContext — the single per-run stream-lifecycle owner.
 *
 * Replaces three parallel structures that used to track in-flight chat runs in
 * `useChatRunTail`: the abort-handle map, the supersession-token map, and the
 * first-delta latch set. They are three facets of one per-run lifecycle, so
 * they live in one record per run.
 *
 * Lifecycle, preserving the prior semantics exactly:
 *   - `claim(runId, token)` stamps the supersession token (entry created on
 *     first claim; the abort handle and first-delta latch are preserved across
 *     re-tails, matching how the token map persisted while the abort-handle map
 *     was deleted on finish).
 *   - `beginStream` / `endStream` register and clear the live `AbortController`.
 *     `abort === null` is the single source of truth for "not currently
 *     streaming" (the old abort-handle-map membership check).
 *   - `abortAll` aborts every live stream and bumps every token (supersession),
 *     leaving the first-delta latch intact — exactly the old `abortAll`.
 *   - `latchFirstDelta` flips the per-run latch and reports whether this was the
 *     first delta, so `onFirstDelta` fires once per run.
 *
 * Holds no React state; instantiated once behind a ref.
 */

interface RunStreamEntry {
  token: number;
  abort: AbortController | null;
  firstDeltaSeen: boolean;
}

export class PerRunStreamContext {
  private readonly runs = new Map<string, RunStreamEntry>();

  private entry(runId: string): RunStreamEntry {
    let entry = this.runs.get(runId);
    if (!entry) {
      entry = { token: 0, abort: null, firstDeltaSeen: false };
      this.runs.set(runId, entry);
    }
    return entry;
  }

  /** The live supersession token for a run (0 if never claimed). */
  currentToken(runId: string): number {
    return this.runs.get(runId)?.token ?? 0;
  }

  /** Has this run been superseded since `token` was issued? */
  isSuperseded(runId: string, token: number): boolean {
    return this.currentToken(runId) !== token;
  }

  /** Take ownership at `token`; preserves the abort handle and first-delta latch. */
  claim(runId: string, token: number): void {
    this.entry(runId).token = token;
  }

  /** Is a live stream currently registered for this run? */
  isStreaming(runId: string): boolean {
    return this.runs.get(runId)?.abort != null;
  }

  /** Register the live stream's abort controller. */
  beginStream(runId: string, abort: AbortController): void {
    this.entry(runId).abort = abort;
  }

  /** Clear the live stream; keeps token + first-delta latch for a re-tail. */
  endStream(runId: string): void {
    const entry = this.runs.get(runId);
    if (entry) entry.abort = null;
  }

  /** Abort every live stream and bump every run's token (supersession). */
  abortAll(): void {
    for (const entry of this.runs.values()) {
      entry.abort?.abort();
      entry.abort = null;
      entry.token += 1;
    }
  }

  /** Flip the first-delta latch; returns true only the first time per run. */
  latchFirstDelta(runId: string): boolean {
    const entry = this.entry(runId);
    if (entry.firstDeltaSeen) return false;
    entry.firstDeltaSeen = true;
    return true;
  }
}
