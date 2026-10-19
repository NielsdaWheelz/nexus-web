# nexus retrieval defects replace the whole workspace

status: deferred (owner decision) · origin: 2026-09-28 nexus launcher rewrite (size/nexus-launcher-web), verified finding F19 · area: nexus / error policy

after the openables typed-wire cut on `acffc634`, both `/search` and
`/resource-items/openables/search` and their clients use generated response types;
their local wire decoders are retired. `lib/nexus/useNexusFind.ts:80–85` still throws
non-api retrieval errors or a same-system defect such as `E_INTERNAL`
(`isSameSystemApiDefect`). the authenticated workspace
boundary (`app/(authenticated)/AuthenticatedWorkspaceErrorBoundary.tsx:49`) replaces
every pane with "Something went wrong in your workspace". the original 2026-09-28
local evidence was `GET /search` answering 500 without an embeddings key after two
typed characters; that environment outcome has not been rerun here.
`docs/rules/boundaries.md` prescribes treating
same-system violations as defects, so demoting them to a per-source Retry contradicts the
mirrored rules.

impact: one failing read route takes down the whole workspace, not just the Nexus results.

prerequisites: an owner decision on the boundary rule for read-only, optional sources.
typing both routes does not change the deferred error-policy decision.

fix (if accepted): show a per-source failure row with Retry for `E_INTERNAL` on openables and
search, as the transport codes already do; keep throwing for genuine contract mismatches.

resolved when: the owner has decided; if accepted, a 500 from `/search` shows a Retry in
the Nexus and leaves the workspace intact.
