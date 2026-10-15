# shared engineering rules still mandate sealed handles

**problem**: `docs/rules/keys-and-identities.md` ("Handle", "Sealing") makes sealed
handles the default outward form of internal identity. the owner decided on
2026-10-10 that users, library invitations and resource grants travel as plain
uuids; the libraries slice removed their handles and
`docs/local-rules/typed-wire.md` now overrides the rule for them. the subtree is
edited only upstream.

**impact**: an agent reading the shared rules first may reseal a user, invitation
or grant id on a new route.

**evidence**: `grep -n -i "sealed" docs/rules/keys-and-identities.md`.

**resolved when**: engineering-docs qualifies the sealed-handle default and the
subtree pull lands here, or the owner decides the local override is the
permanent form.
