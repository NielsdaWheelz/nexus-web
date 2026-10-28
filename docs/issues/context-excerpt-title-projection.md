# context excerpt title projection

the current-main integration feeds scoped full excerpts into compact context
titles. `lib/chat/contextItems.ts` requests `kind:excerpt`; `authoredPreview`
passes that full view into `ResourceIndexBody`, including its full label and
action names. the passage title also references deleted `styles.exact`.
paths are under `apps/web/src`; this is a static review finding after merging
`fff2266c9`, before final qualification.

use the shared compact projection for compact title evidence and retain full
evidence in its separate body. remove the stale style dependency. resolved when
a long scoped capture has a bounded title, correct readable presentation and a
complete separately rendered body, without duplicate full-view controls.
