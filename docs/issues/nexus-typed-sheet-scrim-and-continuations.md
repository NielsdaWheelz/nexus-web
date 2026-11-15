# typed sheet geometry trades thumb reach and scrim area for stable rows

problem: `Switchboard.module.css:73-76` gives the typed sheet a 100dvh flex basis
clamped by the available viewport. the thumb index removes the reversed list
and continuation band: the armed search continuation is a sign at the fixed
legend end beside the field. the remaining scrim is only max(24px, safe-top).

impact: little scrim remains tappable. the geometry preserves the settled
requirement that arrivals never move shown rows; search-all is now thumb-adjacent.

resolved when the owner accepts these two costs in the release/pr decision record,
or a designer provides geometry that proves both stable arrival offsets and better
reach/dismissal. keep back, handle drag and the field available throughout.
