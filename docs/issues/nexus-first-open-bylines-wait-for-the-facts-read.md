# cold palette opens before remote pane bylines are known

status: open · area: browser workspace admission / workspace presentations

round 2 at c8f27acf0 proves the first-frame requirement still fails in both
engines. desktop mounts no catalog provider: `DeviceWorkspace.tsx` alone mounts
it. `BrowserWorkspace.tsx:43-50` loads account, profile and workspace; stored
visits carry title hints, not contributors, and the shell receives empty seeds.

exact evidence: run `20261102-160429-d8fb80411e6c`, palette-10 chromium trace:
Meta+k at 537407.181; first successful workspace-presentations response completes
at 537815.602, about 408ms later. it contains all three required authors. three
earlier requests for identical locators were aborted. firefox also loses authors
for the first three sampled frames. palette-07 chromium types `ka` at 397447.715;
its initial facts complete at 397470.157, after synchronous rows have frozen their
lines for that query. the third book has no other completed detail read at open.

impact: cold blank rows gain a line and move siblings; typed rows retain missing
bylines. the stable read identity repairs revalidation blanking and the catalog
branch supplies installed-device facts, but neither provides unseen browser facts.

narrow repair: opening no longer restarts an adequate pending read; freshness
normalizes empty recents, ignores unrelated authored/capture revisions and layout
order, and retains remote recent revision checks needed for removal safety.

blocker: an explicit admission policy is pending owner choice. initial bootstrap
can supply remote facts before publishing a cold workspace, or palette admission
can wait for them. do not add hidden delays, guess authors, or add a desktop cache.

resolved when the chosen admission contract preserves local authored authority
and ordinary offline opening, and palette-10 and palette-07 pass in both engines
without weakening first-frame byline assertions.
