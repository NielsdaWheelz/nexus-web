# consumption result builds the next item twice

status: deferred · origin: 2026-10-04 source audit · area: consumption projection

`python/nexus/services/consumption/service.py:359–404` selects a visible, capability-matching next row from the recorded memo and calls `projection.build_item`, then builds the full lectern snapshot containing that same row. `python/nexus/services/consumption/projection.py:238–256` routes both through `_items`, repeating read-state and player-descriptor batches. this is avoidable work, not an observed incorrect result or measured latency.

acceptance: use the one full snapshot's already-built next item while retaining the current memo identity, row visibility, activation-kind/capability and current-state replay checks. verify equal next-item and full-deck projections and once-only effects for fresh and replayed finish/natural-end commands, including no-match, hidden-row and changed-capability controls; confirm the selected row is no longer projected twice.
