# selection history rejects valid resource labels

- status: open
- origin: 2026-09-13 second-tab crash investigation; local sha `7fa89b88c8342bca9edfb46a6d20053c49555fb2`, deployed sha `7e8fd48244b3b436965037738e05785bb4931be1`
- area: nexus history request contract

`python/nexus/schemas/nexus_history.py:15` accepts queries up to 500 characters
and line 17 caps `label_snapshot` at 120. resource labels are unrestricted
strings (`python/nexus/schemas/resource_items.py:286`), and nexus preserves
their complete text (`apps/web/src/lib/nexus/results.ts:691`).
`apps/web/src/components/nexus/useNexusController.ts:1151` submits the query
and line 1153 submits the full label without a compatible bound. both
contracts and that producer are present in deployed sha above.

selecting a legitimate 121-character resource title therefore produces a
400 `E_INVALID_REQUEST` from the deployed request-validation handler
(`python/nexus/app.py`, deployed lines 289–292). the history journal sends
after two animation frames plus 500 ms. the controller treats that response
as a defect and raises it through the entire workspace; see
`second-tab-selection-history-can-fail-workspace.md`. this deterministic
source-level trigger has not yet been reproduced against the user's failing
production interaction.

later user evidence shows concurrent 502 responses and the exact client
message `Request failed with status 502`; the incident also occurs within
one pane. this title-bound defect remains real but is not the supported
explanation of that incident. see
`second-tab-gateway-outage-classified-as-workspace-defect.md`.

prerequisites: define history's title and query semantics separately from
display titles and search input. decide whether a label snapshot preserves
the selected display text or is derived from the canonical target. retain
bounded request ingress, canonical target validation, and replay identities.

proposed fix: make a single history command contract accept every supported
selection. if history stores an excerpt, explicitly normalize and bound that
excerpt at the owned command boundary with matching server validation;
never truncate the canonical title or identity. if history must preserve
the full title, derive it server-side or align its bound with the resource
contract. give query normalization the same explicit owner; the current
server already normalizes stored queries to 200 characters after validating
the incompatible 500-character raw input. contain failures independently.

acceptance: real api and browser proofs open/select labels at 120 and 121
characters, unicode labels, and queries at the agreed boundary; navigation
survives, one history use is recorded, and the stored snapshot has the
specified meaning. malformed requests still fail strictly. demonstrate
regression sensitivity through `./scripts/test`.
