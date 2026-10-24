# qualify spoken workspace feedback

the identity defect is repaired: `WorkspaceFeedback.tsx:136` passes the transient
occurrence to `Announcement`; `Activity.tsx:182` publishes only its exposed host.
real-browser checks observe two identical deliberate copy events as two separate
live-region publications, without focus movement. this establishes dom behavior,
not actual speech. no spoken screen-reader result has been observed.

remaining: with an actual screen reader, copy a message twice within five
seconds; retry an unresolved command; open an unrelated modal and activity.
each deliberate event must speak once, ordinary renders/busy updates must remain
quiet, and only the exposed presenter may speak. verify named undo context and
visible focus return when reader chrome is hidden.

resolved when those interactions pass on the current build with an actual
screen reader. record a concrete defect separately if one is observed.
