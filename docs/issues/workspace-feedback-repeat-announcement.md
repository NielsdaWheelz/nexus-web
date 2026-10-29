# qualify spoken workspace feedback

the quiet-feedback cutover puts eligible-host speech in
`apps/web/src/components/feedback/FeedbackLayer.tsx` and occurrence acknowledgement
in `components/feedback/scope.ts`. `Feedback.tsx` owns publication and deliberate
retry outcomes. the former workspace portal and activity presenter are retired.
earlier browser checks established dom publication only; no actual spoken
screen-reader result qualifies the new composition.

remaining: with an actual screen reader, copy a message twice within five
seconds; retry an unresolved command; open an unrelated modal and recovery.
each deliberate event must speak once, ordinary renders/busy updates must remain
quiet, and only the exposed presenter may speak. verify named undo context and
visible focus return when reader chrome is hidden.

resolved when those interactions pass on the current build with an actual
screen reader. record a concrete defect separately if one is observed.
