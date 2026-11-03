# library settings restores a rename after its unavailable read

problem: the settings owner clears request/unknown when its read returns404,
but a previously dispatched rename can later restore that request in its catch.
the unavailable early return renders no Hold, so the restored loss guard can
have no visible command recovery.

evidence at integration57f76e33: `apps/web/src/components/LibrarySettingsDialog.tsx`
86 derives gone;99 clears request/unknown;104-115 renders unavailable before
the held owner;143 restores the captured request after a modeled unknown reply.
the historical lane recorded the race in repair3 but left it unresolved. root
confirmed these transitions in source; no runtime schedule has been induced.

inspect the complete read/rename authority and retained draft lifetime before
repairing: a masked404 may mean unavailable membership, not permanent deletion.
do not invent settlement authority from it or merely hide a retained command.
fix at the existing settings draft/command owner, preserving exact frozen rename
and current transport remedies. no new protocol, inventory or lifecycle owner.

resolved when a delayed real-owner rename response after an unavailable read
cannot create inaccessible pending recovery or an obsolete guard, and genuine
unanswered intent remains reachable until authoritative settlement or deliberate
guarded abandonment. qualify the adverse schedule in both engines and review
the accepted/known-refusal/unknown branches independently.
