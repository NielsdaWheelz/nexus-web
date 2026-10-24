# repeated background suggestion errors can be silent

an active suggestions section remembers announcement text for its entire mount.
a second background read failure with the same error message stays visible but
receives no new spoken announcement, even after the first failure recovered.

`apps/web/src/components/collections/SuggestionsSection.tsx:76-85` builds a
`read-error` key from its title and error message, then retains that key in
`announced.current`. recovery never removes it. this text-based deduplication
predates quiet suggestions; inline retry still speaks its pending/outcome cycle.

reproduce by failing an eligibility read, allowing a successful reconciliation,
then failing another eligibility read with the same modeled error. keep the pane
active and inspect its live region. the second notice appears without a new
announcement.

resolved when separate failure occurrences after recovery each speak once, while
pane refresh remains the sole speaker for its failures and successful background
publications remain silent. use the existing failure owner; no new feedback system
is needed. no runtime reproduction has been performed for this follow-up.
