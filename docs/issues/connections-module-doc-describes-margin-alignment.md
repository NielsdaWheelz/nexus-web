# connections module doc describes the margin's old alignment

problem: connections-scroll lane 4 replaced the margin's per-row alignment with a rigid stack, and deleted its
placement floor, its pivot sweep and its own resize observer. the lasting docs still describe the old margin.
`docs/modules/connections.md:117-118` says an editor replacing an insertion line "uses the normal placement floor",
and its margin paragraphs describe alignment. `docs/issues/margin-placement-observers-miss-replaced-rows.md:13` cites
`E/EvidencePane.tsx:343`, a line that no longer exists.

impact: a reader of the module doc learns a margin the code no longer has.

evidence: lane 4's review, finding 5; `git grep -n "placement floor" docs/modules/connections.md`.

resolved when connections.md states contract M (a rigid stack; a base the text alone moves, one-sided at up to 3x;
a reveal folded into the base; a pin that pushes on collision; rows clipped like text at the top edge), and the
observers issue is deleted on a11 below's proof, as the spec's "resolves" list says. lane 5 owns both.
