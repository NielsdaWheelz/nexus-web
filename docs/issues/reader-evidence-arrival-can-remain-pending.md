# reader evidence arrival needs remaining race verification

the sidebar change retires requests at `MediaPaneBody`, checks current request
and visit identity, and reports unavailable rows instead of awaiting a callback
forever. source review found no remaining defect. deleted-target navigation and
stalled full-navigation supersession passed against the isolated live stack.

the campaign did not force a same-visit local reveal replacing an incoming
evidence request, or target removal after preparation but before row delivery.
those timing cases remain unverified; a passing navigation-away test does not
prove them. host disk exhaustion ended the campaign before those cases; the
isolated environment has since been removed.

resolved when those live cases settle each request once, preserve the newer
request, avoid stale view/filter/scroll/focus changes, and show no false
location-unavailable error. retain unrelated applied passage inspection.
