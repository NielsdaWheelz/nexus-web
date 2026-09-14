# document map drains all evidence into one response

- status: open
- origin: 2026-09-13 second-tab investigation; revision `7fa89b88c8342bca9edfb46a6d20053c49555fb2`
- area: reader document map resource budget

## evidence

`python/nexus/services/reader_document_map.py:112-140` loads all media highlights,
apparatus, graph connections, and embeds before building the map. its helper at
`:181-206` drains every 100-row graph page into one list. the aggregate therefore
removes the lower layer's page bound and retains the full evidence set.
`python/nexus/services/highlights.py:798-805,825-845` likewise materializes every
matching highlight. deployed revision
`7e8fd48244b3b436965037738e05785bb4931be1` has the same aggregate behavior.

this is a static resource-scaling hazard, not a measured explanation of the
reported second-tab workspace exception.

## prerequisites and fix

measure evidence counts and aggregate response size for affected documents.
define which information the initial map must show and an explicit response
budget. return compact counts/structure and revision-pinned, paginated evidence
details; retain complete navigation and explicit continuation. avoid silently
dropping annotations or connections to satisfy a numerical cap.

## acceptance

through `./scripts/test`, demonstrate bounded initial response work and memory
for a large evidence set, complete traversal without duplication or omission,
and coherent snapshot changes. confirm two simultaneous reader panes remain
usable. capture the current aggregate violating the chosen budget before
accepting the fix.
