# workspace feedback moves a published account menu

the sync-sign-out journey at source `fae96229c` completed its offline rich
checkpoint, opened the account menu, then timed out activating `Sign Out`.
playwright resolved the available menuitem, but it detached before becoming
stable and did not return. the sign-out decision itself was never reached.

evidence: private lab `20261021-162915-5bb151a5f90d`,
`writing-recovery.spec.ts:755`, failure `locator.click: Timeout 15000ms exceeded`.
earlier real runs passed this journey. the offline workspace-session save failed
after menu publication. `Feedback.module.css` lets its footer shrink the whole
application, moving the bottom-aligned account trigger and menu. `ActionMenu`
correctly rejected changed geometry and announced that actions changed. no
navigation or sign-out request occurred.

the writing sign-out case starts after the actual offline workspace warning;
there is no click retry, forced activation or sleep. global feedback placement
is outside this writing cutover. the remaining user-facing layout disruption is
resolved when new feedback cannot displace a published menu, without covering
content or weakening its safe-activation contract.
