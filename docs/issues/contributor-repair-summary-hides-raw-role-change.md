# contributor repair summary hides a raw-role correction

status: open; low priority, full fenced preview is accurate
origin: 2026-10-15 retained-book clone rehearsal, candidate `150328b65`
area: contributor repair / operator output

the accepted frankenstein repair changes only `raw_role` from null to `aut`.
its `moved` summary nevertheless reports `author → author`. the full ordered
before/proposed credits and actual state comparison show the correct change;
this is an ambiguous summary, not a false mutation or failed fence.

evidence: private `c-sources/contributor-frankenstein-apply-v2` actual proof
receipt `47d3fe04dae74ca224867e35f3ab28ff1f5eb5af97427cd5a16d676243527e54`.

next: make the existing operator's summary describe the changed credit field
without adding a reporting framework. no qualified repair behavior changes.

acceptance: role-only, ordinal-only and raw-role-only corrections produce
accurate summaries consistent with the complete fenced preview.
