# inspector trigger consumes pane identity space

status: open; locally qualified and cleaned up, production smoke pending
origin: 2026-10-14 inspector design review; baseline `367da80e0`
area: workspace / pane chrome

baseline `367da80e0` rendered `companion.label` beside the desktop icon,
consuming pane-title space. implementation `e22699ad0` removes that caption,
uses the shared 20px glyph and accessible name, and adds passive help through
the existing overlay kernel. a reproduced detached-caption engagement bug is
also fixed and verified in chromium, firefox and webkit. the controller and
durable inspector state remain unchanged.

implement the [inspector control plan](../inspector-control-plan.md). the user
approved inspector-only scope and isolated local qualification followed by a
production smoke check; navigation tooltip repair remains separate.

reviewed disposable red/green journeys and independent architecture/design/
accessibility review are recorded in [verification](../inspector-control-verification.md).
scoped cleanup and the final `./scripts/test` passed. follow the normal release
owner; production smoke must exercise the released candidate, not an older
build. physical-device and spoken-output coverage remain explicit limits.

acceptance: all seven plan journeys pass, `./scripts/test` passes, disposable
qualification resources are deleted, and sanitized evidence is recorded.
delete this ticket only after the remaining release smoke is recorded.
