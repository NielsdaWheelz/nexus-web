# default page title conflicts with its own publication

an unnamed page submits `untitled` but carries an empty title snapshot. its
acknowledgement correctly detects different authored content, then wrongly parks
the page's body successors because the adapter supplied inconsistent desires.

run17 `ad7815f03`, native first-publication ime: `first-publication-ime-failure.json`
under `.nexus-local/lab/20261021-170114-42049dd78ecb/artifacts/writing-device/`.
the original editor, selection and composition survived acknowledgement; rich
`We still ` remained revision5/base `We `/v1 with dependency-review blocked.

publication must carry its actual default title before the atomic title/body
snapshot, without replacing a subsequent title edit. resolved when the actual
native first-publication journey checkpoints and syncs the successor, with no
title conflict, and explicit/newer titles retain their exact values.
