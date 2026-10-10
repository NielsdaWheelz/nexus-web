# the resource graph reauthor is over its line budget

status: open · origin: 2026-10-10 graph reauthor · area: resource graph / reauthoring

the reauthor measures 3,997 formatted lines (python 2,784, web 1,213; ruff format at
the repo config, prettier 3.3.3 defaults; `wire.gen.ts` and the migration excluded)
against the restated 3,900 cap (decisions R2), from 6,023. none of the design's §16
levers is taken. formatted count (design budget):

python `services/resource_graph/`: resolve 542 (540), edges 455 (435), links 279
(275), context 213 (200), connections 211 (200), citations 208 (200), reader_targets
192 (175), cleanup 130 (120), refs 80 (80), highlight_notes 79 (75), owners 33 (33);
`schemas/resource_graph` 234 (225), `api/routes/resource_graph` 80 (80),
`schemas/citation` 48 (45).

web: useLinkComposer 359 (320), links 132 (125), citations 122 (112), resourceRef
81 (78), LinkTargetDialog 274 (270) + css 95 (90), resourceItems 68 (62), activation
44 (44), openableResources 19 (18), resourceLocators 19 (17).

where the sketches undercounted: reader_targets keeps the apparatus readiness filter
and the "Reader target unavailable" 404 the sketch dropped (+17); edges keeps the
explicit lock, restore and motif filters (+20); useLinkComposer keeps an explicit
public interface, a memoized binding and both defect paths (+39); the four small web
modules were already minimal and are unchanged (+9 against estimates); the rest is
prettier and ruff expanding calls the sketches wrote compactly.

impact: 97 lines (2.5 %) over the cap; no behaviour impact.

resolved when: the owner accepts the overrun, or a later pass finds an honest
simplification that brings the measured total to 3,900 or less.
