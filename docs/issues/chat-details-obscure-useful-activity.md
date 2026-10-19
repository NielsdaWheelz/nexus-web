# chat details obscure useful activity

status: open
origin: 2026-10-16 owner request; revalidated on main `48bc7fbad`
area: web / chat / information hierarchy

`apps/web/src/components/chat/AssistantTrust.tsx:109-193` still renders the full
fact/count report, numbered context, generic tool labels/status and bookkeeping.
the merged viewer moved it into `MessageDialogs.Information`; `MessageFooter`
also opens a separate sources dialog. canonical resource items/navigation are
already present after pr646; that earlier navigation gap is resolved.

impact: the reader must decode administration and repeated success claims to
learn which resources and operations matter. reducing font size would worsen
legibility; these rows already use small text.

prerequisite: follow compact chat details (#647), the bounded
follow-on to the merged viewer. reuse its footer, source-target projection and
scroll owner; add complete historical-context and semantic action projections.
do not reopen viewer commands/typography or add another inspector/event store.

acceptance: one-step inline disclosure shows provider/model/effort, unnumbered
linked context and concrete chronological actions. success/accounting noise and
duplicate citation lists are gone. failures, uncertain outcomes and writes with
undo remain visible; source and action inspection work with keyboard and touch.
