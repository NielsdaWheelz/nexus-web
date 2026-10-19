# a new deep link at the pane cap discards the first pane

status: open
origin: 2026-10-16 pane reorder design audit
area: web / workspace / entry

problem: entering through an unmatched deep link with twelve saved panes
silently removes the first pane and its history. proposed manual reordering
would make a pane's chosen screen position its eviction priority.

evidence: `apps/web/src/lib/workspace/model.ts:99-102` retains only
`restored.panes.slice(1 - MAX_PANES)` before appending the destination.
`apps/web/src/lib/workspace/store.tsx:136` initializes recently closed empty,
so entry eviction has no restore entry. this differs from live target
activation, which rejects creation at the cap. the entry policy is currently
documented in `docs/modules/workspace.md:56-60`; this is a design hazard,
not an observed violation of that policy.

prerequisite: decide the entry-at-cap behavior before shipping reorder.
fix: preserve every existing pane and offer an explicit replacement choice,
or adopt a deliberate history-preserving navigation policy; do not treat
visual order as recency.

acceptance: loading an unmatched deep link at twelve panes cannot silently
lose an existing pane or its history, regardless of the chosen strip order.
