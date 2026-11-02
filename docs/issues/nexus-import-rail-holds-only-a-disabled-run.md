# an unavailable import opens a rail with nothing usable

status: open · origin: 2026-11-02 palette s3/s4 adversary · area: web / nexus verb rail; owner’s call

criterion 8 ends "an unavailable primary keeps a usable rail", and palette-08
proves it on `/i` with 21 links (`add up to 20 items at a time`). the verb
sheet gives `import`, `/i` and pasted urls `run ↵` only: no `new pane` (add
ignores disposition), no read verbs, no menu, so no `more`. `nexusRowVerbs`
follows the sheet (`NexusRow.tsx:205` pair `[run]`, `:208` menu null), so
`NexusVerbRail` composes one chip, `run`, disabled with its reason
(`NexusVerbRail.tsx:70-75`); initial focus falls to it and enter consumes
silently (`nexus-rail-disabled-verb-is-silent.md`).

the sheet and the criterion cannot both hold for this row kind: the sheet's
promise ("initial focus is the first chip after the pair, so a usable verb or
`more`") assumes something after the pair.

evidence: inferred by reading; palette-08 failed earlier on this tree
(`palette-case-08-rail-items-miss-link-chips.md`) and never reached the step.

impact: `→` or tab on an unavailable import opens a toolbar whose only control
does nothing; the reason is readable (description, tooltip) but nothing acts.

fix, owner's call, named in the pr: (a) `→` and tab do nothing on a row whose
rail would hold no enabled verb and no `more`, extending the sheet's
"continuation armed" rule, and palette-08 proves criterion 8 on a row with read
verbs (an unavailable passage with `show excerpt`); or (b) the import rail
gains `more` over a menu import does not have today. (a) keeps the sheet; (b)
keeps the case.

resolved when the owner has chosen, and palette-08's last step passes in both
engines on the chosen behaviour.
