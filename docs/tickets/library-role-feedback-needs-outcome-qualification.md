# library role reconciliation does not distinguish ambiguous command outcome

status: open. origin: 2026-10-04 frontend source audit at `bbfd1df4`; area: library governance web. priority: p2.

`apps/web/src/lib/libraries/useLibraryMembers.ts:743-771,816-855` classifies a modeled command error, then rereads and adopts authoritative member pages. it nevertheless attaches the command failure and, for a role command, announces “No confirmed role change was applied.” without comparing the reread role to the requested role. if the server committed the patch but its response was lost (`E_NETWORK`), the pane could show the requested role alongside that message. the reread alone cannot attribute the role to this command; the actual user-visible outcome remains unverified.

first establish the actual command/reread sequence and whether the message misleads. if so, settle ambiguous role commands at the library-governance owner while keeping genuine failures, concurrent changes, and stale-route fences distinct. acceptance: feedback is truthful for a committed patch with lost response, a rejected patch, and a concurrent role change. delete this ticket if the observed behavior is already correct.
