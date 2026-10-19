# cutover reruns must distinguish a committed migration

status: open until the one-time cutover tooling is retired
origin: 2026-10-13 release source review at `82eb4babe`
area: release recovery guidance

the campaign plan says to rerun the same deploy command after a refusal.
`deploy/hetzner/release.py:649` instead rejects `--model-cutover-snapshot` once
the starting revision has crossed 0246. if migration commits and subsequent
startup or promotion fails, that exact command cannot continue unchanged.
this is a source-level recovery hazard; no such live failure has been observed.

inspect the actual database revision and the committed archive receipt before
recovery. a later invocation without the one-time reviewed input must preserve
and verify the original pre-migration backup; never dump over it or restart the
old application on the new schema. retain the reviewed input and restore proof.

acceptance: after successful cutover, remove this obsolete branch and its
misleading rerun guidance in the separately planned tooling cleanup; if recovery
is needed first, document the exact observed state and qualified invocation.
