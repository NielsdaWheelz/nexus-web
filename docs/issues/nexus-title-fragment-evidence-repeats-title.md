# a name match paints a fragment of its own title as evidence

status: open · origin: 2026-11-02 palette s2 repair · area: web / nexus rows (s3), server direct phase

the direct phase's name match carries `match = _evidence(name.literal, terms)`
(`python/nexus/services/search/navigation.py:56-76,150`): `excerpt_window(literal,
start=<match start>)` opens the window AT the matched span, so for `attention` in
`Notes on Attention` the excerpt is `Attention`, `truncated_before = true`.
`bodyEvidence` (`NexusRow.tsx:86-91`) nulls a media match only when the excerpt
text equals the whole title untruncated, so this row paints a third line
`…Attention` under `Notes on Attention · Iris Murdoch`: the title repeated as
evidence, which the row sheet's law 4 forbids and its before/after table
(`…-04-settled-attention` · remote book) shows fixed as the title underlined in
place with no evidence line.

evidence: lab run `20261101-235405-493d47cab729`, palette-05 chromium, word
`attention`: arriving row named `Notes on Attention. Herbert Simon. Attention`.
(the Murdoch pane row no longer reshapes: s2 keeps a shown row's lines for the
life of the query, `rows.ts` `refreshed`.) a remote-only row still arrives in
this shape.

impact: remote name-matched media rows show three lines and speak the title
twice; `MediaTitle` cannot render ranges, so the title never underlines.

fix: in `NexusRow` (s3), treat a match whose excerpt is a window into the
painted title (the title contains the excerpt text at the window's offset) as
inline: underline the ranges in the title, no evidence line. alternatively the
server's `_evidence` returns the whole literal with ranges when the literal is
short (a title), so `separateMatchEvidence`'s existing equality rule applies.

resolved when a remote `Notes on Attention` row under `attention` has two
lines, `Attention` underlined in the title, and its accessible name is
`Notes on Attention. Herbert Simon`.
