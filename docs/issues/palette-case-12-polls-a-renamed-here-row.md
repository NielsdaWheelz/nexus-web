# palette-12 polls for the current pane under its pre-rename name

status: open · origin: 2026-11-02 palette s3/s4 repair · area: lab case (s0), `apps/web/.nexus-lab/cases/palette-12-names.spec.ts:32,45` (ignored)

the case's workspace makes Moby-Dick the active pane (`active: 1`), types
`moby`, and waits for the armed row's name to match `/^Moby-Dick/` before it
opens the row's menu. the current pane's row carries the `here` part first:
"`current` becomes the `here` part" is in the contract's rename list
(content), and `nexusRowName` puts `here` before the title
(`NexusRow.tsx:126`). the row is armed and correct; the poll never matches.
the case's own `RENAMED` list already exempts `gridcell "here…`.

evidence: lab run `20261102-120048-554a7e7740c0`, palette-12 chromium:
`Expected pattern: /^Moby-Dick/ / Received string: "here. Moby-Dick; or, The
Whale"` after 15s.

impact: criterion 12's names diff never runs (blank, typed and strip snapshots
are taken; the menu snapshot and the comparison are not).

fix (case author, not the implementer): poll `/^(here\. )?Moby-Dick/`, or make
another pane active.

resolved when palette-12 reaches its baseline comparison on the s3/s4 tree.
