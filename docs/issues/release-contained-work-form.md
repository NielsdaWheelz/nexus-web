# release contained-work form removal

the cutover discards stored literary classifications, including user edits.
deploy the matching api/workers/web and paired clients through `deployment.md`;
stop writers and take its verified backup before migration. downgrade refuses;
recovery requires the matching backup/build, not a recreated empty column.

on 2026-10-28 the public web/api `/version` both returned
`3d81ef45ef28f637a4de07c66ab172bbab9e22c2` (schema 0317); that source uses wire 16.
the integration base `d4d108f2d` already carries unshipped wire 17, so this
change shares it. recheck release identity before deployment; if another release
ships first, reassess the once-per-release revision rule.

migration `0321`, after local-first writing `0320`, removes `media_parts.form`
and only the `form` key in every
non-null candidate finding, preserving identities, versions, decisions and text.
old captured discovery jobs finish superseded through the prompt fingerprint;
request discovery again explicitly where needed. no corpus scan or index rebuild.

deployment and deployed acceptance remain pending: verify exact schema/wire and
matching services, inspect retained pieces/candidates, and confirm create/edit
and discovery with the smaller contract. local qualification is separate proof.
delete this record when the coordinated release and these checks are complete.
