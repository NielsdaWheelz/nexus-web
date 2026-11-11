# connections row layout needs rendered qualification

the old grid-cell collision is superseded. the 2026-10-28 source review at
`0f7d6ffa6` found that `ResourceOutlineRow` renders primary content, attribution
and details in ordinary flow; the old `ResourceRow` slots no longer establish
a current defect. the [connections contract](../modules/connections.md) owns
the current presentation.

the remaining gap is a rendered check of rows with an excerpt and applicable
creation, dismissal or relationship details together. verify desktop and narrow
widths: every field remains legible without overlap. no such journey was run
in that review or during this documentation cleanup. close after that check;
do not restore the obsolete grid or link-note implementation proposal.
