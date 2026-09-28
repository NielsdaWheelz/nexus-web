# a bare slash command keeps the previous query's active row

status: open · origin: 2026-09-28 nexus launcher rewrite review (size/nexus-launcher-web) · area: nexus

typing `/p` then a space and pressing Enter opens Podcasts, not New Page. `/p` is a plain
search (Podcasts is active); `/p ` compiles to the New Page command, but both trim to the
normalized query `/p`, and `mergeResults` (`apps/web/src/lib/nexus/rows.ts`) restarts the
list only when the normalized query changes. the unmoved active row survives, so Enter runs
it. the same holds for `/c `, `/l ` and `/n `. present before the rewrite (baseline xfail).

evidence: live harness 2026-09-28, launcher suite `test_bare_slash_command_runs_on_enter` (xfail
for `/p ` and `/c `).

fix: restart the list when the compiled intent changes as well as the normalized query, for
example key `setList(mergeResults(...))` in `useNexusController.ts` on intent kind plus norm.

resolved when: `/p ` Enter creates a page and `/c ` Enter opens a new chat on desktop and
mobile, while trailing spaces after ordinary search text still keep the active row.
