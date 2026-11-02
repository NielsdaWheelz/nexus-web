# enter on an unavailable rail verb says nothing

status: open · origin: 2026-11-02 palette s3 · area: web / nexus verb rail

the verb sheet asks that `↵` on a disabled `open` / `new pane` announce the row's
reason. `NexusVerbRail` follows `ActionMenu`'s item activation instead: a
disabled or busy verb consumes enter and click and does nothing; the reason is its
`aria-describedby` text and, on desktop, its tooltip.

impact: a keyboard user pressing enter on an unavailable primary hears nothing new
(the reason was announced on focus through the description).

evidence: `NexusVerbRail.tsx` `run`: `if (verb.disabled || verb.busy) { event.preventDefault(); return; }`.

fix: announce `disabledReason` through the controller's announcement on enter, for
the rail only, or accept the menu's behaviour and amend the verb sheet.

resolved when: `/i` with 21 links, `→`, enter on `run` announces `add up to 20 items at a time`.
