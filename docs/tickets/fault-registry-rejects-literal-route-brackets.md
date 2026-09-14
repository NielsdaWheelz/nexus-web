status: open
origin: 2026-09-12, reader sensitivity run `52f83fb860cc0c0f`, candidate `e169805fa9`
area: test controller fault registry

native `prove` aborted before execution because the fault registry rejected an
existing next route proof: `apps/web/src/app/(authenticated)/media/[id]/mediaEvidenceResolution.unit.test.ts`.
`python/nexus_test_control/policy.py:1305` rejects literal square brackets as
glob syntax even though `_resolved_repository_file` resolves exact file paths.
this invalidates the entire fault registry, including unrelated native owners.

prerequisite: preserve exact repository-file containment and symlink rejection.
admit literal route brackets at the exact-file boundary without glob expansion;
prove traversal/symlink rejection remains intact.

acceptance: a registered product fault may name an existing `[id]` route proof;
`prove` reaches its behavioral red and green. missing or escaping paths still
reject. the reader evidence owner currently uses ordinary base sensitivity;
its regression test and priority-risk registration remain present.
