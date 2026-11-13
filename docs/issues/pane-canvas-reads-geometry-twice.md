# pane canvas geometry has two readers

problem: `apps/web/src/components/workspace/usePaneCanvas.ts` retains intersection
observers for in-view/fully-in-view sets and scheduled rect reads for
`subscribeSpans`. both describe the same canvas geometry with different delivery.

impact: duplicate observation work and two mechanisms to understand. no measured
performance defect is established; the lit-rule cut deliberately retains the
existing presentation/feedback intersection owner.

resolution: consolidate only when one measured geometry owner preserves partial
and full visibility, scheduled span updates, mode transitions and companion
extent. verify activation, resize, minimize, pan and maximized restore through
the real canvas before removing either reader.
