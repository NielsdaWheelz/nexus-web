# pane close key repeat cascades through tabs

status: open · origin: 2026-10-16 pane-tabs review · area: workspace / keyboard close

evidence: `apps/web/src/components/workspace/WorkspacePaneStrip.tsx:68-86`
closes on every delete/backspace keydown without checking `event.repeat`.
`:41-50,61-66` transfers focus to a surviving neighbor after each close, so
holding the key can repeatedly close that neighbor. the store creates a new
fallback pane when the last pane closes (`lib/workspace/store.tsx:397-399`),
and retains only five recently closed panes (`:61,391-394`). source-confirmed
dispatch path; no held-key browser reproduction was run.

impact: one held close key can remove several panes and displace their recovery
entries instead of closing only the intended focused pane.

prerequisites: several desktop panes and keyboard focus on a strip activator.
proposed fix: close only on a fresh key press; reject repeat for any new close
alias or maximize toggle too. repeated directional navigation may remain enabled.

acceptance: holding delete or backspace closes exactly one pane; release and
press closes the next focused pane. closing the final pane produces exactly one
fallback pane, with focus retained in the strip.
