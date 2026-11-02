# typed sheet geometry trades thumb reach and scrim area for stable rows

problem: `Switchboard.module.css:73-76` gives the typed sheet a 100dvh flex basis
clamped by the available viewport. continuations sit outside the reversed results
scrollport, farthest from the field; even with zero principals the armed search-all
row stays there. the remaining scrim is only max(24px, safe-top).

impact: search-all is far from the thumb and little scrim remains tappable. the
geometry preserves the settled requirement that arrivals never move shown rows.

resolved when the owner accepts these two costs in the release/pr decision record,
or a designer provides geometry that proves both stable arrival offsets and better
reach/dismissal. keep back, handle drag and the field available throughout.
