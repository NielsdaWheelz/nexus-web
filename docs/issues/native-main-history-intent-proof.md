# native share intent races remain unobserved

`MainActivity.kt:361-458` owns document generation, intent sequence, pending uri and current/previous history. on source `8e0991b4`, the actual current-share and previous-share journeys qualified native cancel, affirmative leave and return to the exact captured predecessor. cancel retained the original activity, document and history; accepted traversal was ordinary behavior, not cleanup.

pending-link retirement and a newer different or identical uri before an earlier reply remain unobserved. the source's stale-reply checks do not establish actual scheduling. the beforeunload observer's microtask sample also does not establish completed dispatch or final prevention.

close the remaining gap with positive original intent, document, dialog and history evidence for the named races, without private history or callback injection. this record does not authorize a larger matrix or waive those limits. incomplete-upload rotation and leave retain their separate release gate.
