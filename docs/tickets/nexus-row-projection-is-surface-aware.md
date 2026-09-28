# the nexus row projection knows its surface

status: deferred (owner decision) · origin: 2026-09-28 nexus launcher rewrite (size/nexus-launcher-web), verified finding F13 · area: nexus

`apps/web/src/lib/nexus/rows.ts` projects different rows per surface: mobile adds the
Places group (`MOBILE_PLACES`), strips type labels and details from blank groups and
Do-with-query rows, omits the parent, and says "Current" where desktop says "Current tab".
the renderers then trust that projection. a surface-neutral projection with presentation
choices in each shell is the other layering.

impact: the surface branches sit in the semantic layer rather than the two shells. no
defect; this is a layering choice. changing it changes visible mobile copy (mobile rows
would gain type labels and details), and current behaviour is the spec.

fix (if accepted): project one row set; let `DesktopNexus.tsx` and `SwitchboardTask.tsx`
choose groups and fact detail, and derive keyboard order and the default active row from
their visible groups.

resolved when: the owner has decided; either the projection has no surface parameter, or
this ticket is deleted as "keep".
