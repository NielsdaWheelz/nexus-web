# shared engineering rules still mandate Presence<T>

**problem**: the engineering-docs subtree (`docs/rules/boundaries.md` "internal
representation", `docs/rules/json-values.md`, `docs/rules/frontend.md`) makes
`Presence<T> = {kind: "Absent"} | {kind: "Present", value: T}` the one owned-absence
encoding. the owner retired it on 2026-10-13 (plain `null`, snake_case keys);
`docs/local-rules/typed-wire.md` now overrides those rules for this repo. the subtree is
edited only upstream.

**impact**: an agent reading the shared rules first reintroduces Presence on a new wire shape.

**evidence**: `grep -n Presence docs/rules/*.md`.

**resolved when**: engineering-docs drops or qualifies the Presence rule and the subtree pull
lands here, or the owner decides the local override is the permanent form.
