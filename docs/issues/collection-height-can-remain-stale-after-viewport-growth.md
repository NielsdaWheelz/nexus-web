# collection height can remain stale after viewport growth

problem: a measured collection ceiling can keep a compact picker short after
its external space grows. the child ceiling prevents its parent from growing,
so observing their sizes alone need not trigger another measurement.

evidence at `f0748d2b7`: `apps/web/src/lib/ui/collection.ts:41-49` writes
`--collection-available-height` from current body height; `:55-58` observes body/
list sizes and content mutation, not changes to the available external budget.
`components/ui/Collection.module.css:26-32` consumes that ceiling.
`lib/ui/useAnchoredPosition.ts:285-301` can raise the outer anchored ceiling
without changing a child already held below it. component paths are under
`apps/web/src/`. this is a source-derived hazard, not a rendered reproduction.

verify with a compact picker constrained below its preferred height, then grow
the viewport vertically without changing width, content or open state. compare
its height with a fresh open at the same final geometry.

resolve at collection layout ownership by deriving or invalidating available
space from its actual constraint, without duplicated viewport engines or polling.
resolved when compact/fill collections recover their allowed height and preserve
scroll/focus after external bounds grow. the popup-sizing change must not inherit
this stale numeric ceiling in its new natural-height mode; repair of existing
compact/fill behavior is a separate follow-up unless it blocks that change.
