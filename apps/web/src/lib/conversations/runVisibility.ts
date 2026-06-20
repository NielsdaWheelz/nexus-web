/**
 * runVisibility — the single run-visibility decision for chat run tailing.
 *
 * Replaces the five scattered predicates (`shouldApplyRun` / `shouldStartRun` in
 * the engine and the `runIsVisible` / `currentRunIsVisible` / `runCanStart`
 * closures in the run-tail orchestrator). "Does this run start" and "does this
 * run's event apply to the current view" are two facets of one decision; this
 * factory is their only owner.
 *
 * `shouldStart` / `shouldApply` are optional: the linear (reader) engine wires
 * only `shouldStart`, and an absent predicate defaults to `true` — the exact
 * `predicate?.(ctx) ?? true` semantics of the prior closures. `canStart` also
 * gates on `isMounted()`, matching the old `mountedRef.current && …`.
 *
 * Pure given its inputs; no refs, no React.
 */

export interface RunVisibilityContext {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
}

export interface RunVisibility {
  /** May this run begin/continue tailing for the current view? */
  canStart: (ctx: RunVisibilityContext) => boolean;
  /** Does this run's event apply to the currently rendered transcript? */
  isVisible: (ctx: RunVisibilityContext) => boolean;
}

export function createRunVisibility(opts: {
  shouldStart?: (ctx: RunVisibilityContext) => boolean;
  shouldApply?: (ctx: RunVisibilityContext) => boolean;
  isMounted: () => boolean;
}): RunVisibility {
  const { shouldStart, shouldApply, isMounted } = opts;
  return {
    canStart: (ctx) => isMounted() && (shouldStart ? shouldStart(ctx) : true),
    isVisible: (ctx) => (shouldApply ? shouldApply(ctx) : true),
  };
}
