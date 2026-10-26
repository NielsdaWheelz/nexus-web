# preserve new-page visit identity during flat-editor integration

external frozen `f07f1963eb` replaces `PageAccount`'s retained
`usePaneVisitData(NEW_PAGE_IDENTITY)` with a component-local random uuid.
merging that replacement would regress implementation `6ab5d5f77`: leaving and
returning to the same `/pages/new` visit after a true remount changes the latent
page ref and strands the retained draft under its prior destination.

this is an integration source hazard, not a new installed reproduction. the
same-visit identity failure was previously reproduced by the page materialization
case; distinct new visits must still receive distinct ids.

retain the existing account-bound visit identity while adapting the pane to the
flat root-title field. resolve when the merged source preserves that owner and
the real same-pane navigate/back case retains its draft, materializes the same
page on first writing, and gives a separate new visit a new identity.
