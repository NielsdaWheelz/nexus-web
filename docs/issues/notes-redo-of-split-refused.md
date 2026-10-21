# a redo of a split is refused and kept as a draft

status: open; intermittent, load-dependent · origin: resource references re-slice port onto main, 2026-10-19; restated 2026-10-20 · area: notes outline (undo/redo, write queue)

two refs harness journeys type " two" after "one", wait (`N2.undo-redo-across-text-and-structure`
3000 ms, past the 1.5 s save; `N2.undo-split-keeps-unsaved-text-before-it` 300 ms, inside it),
split with Enter, type "three", then undo three steps and redo three. intermittently the redone
split never lands: the outline shows "this change was refused. your drafts are kept." and "that
change couldn’t be saved", and the server ends at `["one two"]`.

measured (failures / runs):

| stack | load average | across-text-and-structure | split-keeps-unsaved-text |
| --- | --- | --- | --- |
| port reviewer, tip `5c04a0294` | 10-24 | 10 / 20 | 6 / 20 |
| port reviewer, main `d9e7d86aa`'s python under the tip's web | 10-24 | 7 / 20 | 7 / 20 |
| port-fix, tip, full cycle + `REPEAT=10` | 4-17 | 0 / 11 | 2 / 11 |
| porter, ports onto main (port-4, final-1) | — | — | 2 failures |

two failure modes:

- the split's command is never sent (most runs): no 4xx in the api log (port-fix's repeat: all 185
  `POST /resource-graph/commands` answered 200), and the journey's write log after the first undo
  holds only the undone split (`remove+set_body:200`). the write queue's build refused it;
  afaict one of `sendEdits`' `checked()` throws (`apps/web/src/lib/notes/useOutline.ts:364-381`:
  409 `E_RESOURCE_CONFLICT` "the insertion position is no longer loaded" or "placement changed;
  refresh before trying this edit again"). not instrumented, so which one is unproven.
- the server refuses it: final-1's api log (`refs/harness/state/final-1-evidence/api.log`) has the
  redone text save answered 200 at 04:18:26.001Z and the redone split's command 55 ms later
  answered 409 `E_NOTE_CONFLICT` "Note changed elsewhere": afaict the split's body edit carried
  the version it captured before that save landed. the reviewer saw this once in a full run.

it is main's: the notes write path on the tip is main's code (under `lib/notes` and
`components/notes` the slice changes only a wire field dropped from a locally built node in
`lib/notes/outline.ts`; the shared `ResourceOutlineRow` is main's file with a new comment), main's
python reproduces it at the same rates, and no run on the slice's old base `d6b73c712` (before
#683/#686) failed.

a candidate cause of the first mode (notes re-slice, 2026-10-21, design L11): every
text save's reply reported its note's links fact with `checked_from_version: null`,
and the queue breaks any position chain through such a fact, so a structure edit
placed inside a note during that note's save window was refused at build. since the
re-slice a text save reports no links fact (I14; notes harness `outline/O34`).

a second, closer candidate (the same branch, D11): a reply reported `checked_from_version`
only for lanes a command checked, so an own unchecked write (a structural remove, a relink's
far end) broke the position chain through its lane. an undone split is such a remove (the
write log's `remove+set_body`), so the redone split's insert could be refused at build;
notes harness `outline/O9` (undo an indent, a split and two edits, redo them) was refused
that way every run until each moved lane reported its batch-start version.

with both fixed (`cleanup/notes-server-queue`), the notes harness's copies of the two
journeys (`outline/O7`, `outline/O8`) passed in every harness cycle run on that
branch's revisions (14 by its port onto main), one run each, unthrottled; that is not the
20-run repeat below. the 140 refusal-free repeats under cpu burners ran on the later
web-engine tree, and burners are no longer an instrument. the throttle's calibration
(lab-host-budget §5) needs a sha before that branch, e.g. its base `61d2d1540`: after it
the failure may stop reproducing for a reason other than the throttle.

the harness XFAILs both journeys only on this signature (server `["one two"]` plus the refusal
copy); an XPASS there is expected while the defect is intermittent.

impact: a person who undoes and redoes a split can see the redo refused and kept as a draft
instead of applied.

resolved when: both journeys pass a 20-run repeat under the calibrated client cpu throttle
([lab-host-budget](lab-host-budget.md) §5) and their `xfail` goes. calibration first proves the
throttle reproduces this failure on the base sha (at least 5 of 20). until that instrument
lands, the operative check remains the earlier form: `REPEAT=20`, prefixes
`notes/N2.undo-redo-across notes/N2.undo-split`, load average above 10.
