# a retired preparation retry can prepare another subject

`ActionMenuHost.tsx:197` captures the failed preparation's name but calls mutable
`local.begin`, which belongs to the current render. subject-change cleanup at215
retracts the report; the stage exit animation still leaves its button connected
briefly. a persistent pane header can therefore route that old retry to a new
subject after same-pane navigation.

evidence is source-only at `6d463695`: `apps/web/src/components/ui/ActionMenuHost.tsx`,
`components/workspace/WorkspaceHost.tsx:339,353` and
`components/resources/ContextualActionMenu.tsx:15-19`. the wrong effect is a read
and menu preparation, not a directly dispatched write. no runtime was induced
by the reviewer.

fence the retry by its originating subject, navigation identity and mounted
host. retraction is presentation, not callback retirement. resolve with an actual
retiring-button journey after same-pane replacement in both engines, proving no
replacement preparation; ordinary same-subject retry must remain usable.
