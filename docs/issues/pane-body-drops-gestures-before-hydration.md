# a server-rendered pane body drops gestures before the client owns it

problem: a freshly loaded pane body is server-rendered and natively operable,
then replaced. the client shows the `Loading pane…` fallback and mounts a new
body, so a gesture made on the server markup is lost. owner:
`apps/web/src/lib/panes/paneRenderRegistry.tsx:75-90` (a lazy body inside
`Suspense`) and whatever update makes that boundary client-render rather than
hydrate in place; the cause is not established and no console or page error
was raised.

evidence: `reader-view-menu` (`cc754eb9c`), lab `20261025-145228-7756cb8144ce`,
case "R ac10 forced colours and reduced motion in reader settings", trace times
in ms. `goto /settings/reader` at 230197; the Theme radios were visible as server
markup (name `_R_qhikutlb5auqebtb_`) at 230630; the case focused Light at 230633
and pressed ArrowRight at 230657; the body's chunk (`8764.…js`) was first
requested at 230733; the screencast at ~230790 shows the skeleton; afterwards
the radios carry client ids (`_r_0_`), Light is checked, nothing is focused and
no reader-profile PATCH was sent. the host ran four labs at load average ~19 on
18 cores. this branch changes neither the registry nor the shell; main was not
checked. the launcher has the same class of gap
(`nexus-launch-click-before-hydration-is-lost.md`).

the complete-index branch independently reproduces replacement with all 200
server rows and no hydration error: source `fb5a7bd53`, private lab
`20261025-183604-aba244cdc7f8`, `index-module-200-hydration.json` and its hydration
trace. the original list remains visible through 639 ms, is removed at 948 ms,
then returns as new nodes at 1,414 ms. body chunks execute after removal. the
initiating ancestor/context update remains unproven; navigation timings cannot
qualify this deep-link path.

impact: an early key or click on a fresh pane is silently discarded, and the
body flashes server content, skeleton, content. slow script startup widens the
window.

resolved when, on a fresh `/settings/reader` load with delayed script startup,
the server-rendered body hydrates in place (no skeleton, same elements) or is
not operable until the client owns it, and an early arrow on a theme radio
either applies once or is visibly unavailable.
