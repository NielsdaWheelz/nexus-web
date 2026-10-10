# The counted unit recorded at a source failure is free text on the wire

**Status:** open
**Origin:** Imports workspace cutover, Track E residual round (E-fix5), 2026-09-09
**Area:** `python/nexus/schemas/import_history.py`;
`apps/web/src/lib/imports/copy.ts`

## What is wrong

Two schemas carry the same fact with two different degrees of typing.

Live progress is a closed literal end to end: `record_source_extraction_progress`
takes `unit: Literal["Page", "Chapter"]`
(`python/nexus/services/source_publication.py:152`), `_source_progress_from_attempt`
refuses anything else (`:287-288`, `AssertionError("counted source progress has an
invalid shape")`), and the browser decoder narrows it with
`expectOneOf(value.unit, ["Page", "Chapter"])`
(`apps/web/src/lib/media/sourceProgress.ts:77-80`). So `progressLine` in the copy
owner indexes a closed per-unit record
(`apps/web/src/lib/imports/copy.ts`, `statusLine`).

The progress recorded *at a failure* carries the same column and the same two
values, but its schema declares it as text: `SourceFailureProgress.unit:
Presence[str]` (`python/nexus/schemas/import_history.py:199-202`), filled from
`attempt.progress_unit` without narrowing
(`python/nexus/services/source_publication.py:55-71`). The generated wire type is
therefore a string, and the copy owner cannot switch on it: `failureProgress`
(`apps/web/src/lib/imports/copy.ts`, used by `eventLine`) renders the
recorded unit lowercased — `Stopped at page 480 of 712.` — which is correct for
both live values but is not the exhaustive match the rules ask for
(`docs/rules/control-flow.md`, `docs/rules/tagged-unions.md`), and would silently
render a future third unit rather than defecting.

## Prerequisites

`schemas/import_history.py` owns the wire type; the web reads it through the
generated contract, so narrowing it there narrows the copy owner's input.

## Proposed fix

Declare `SourceFailureProgress.unit: Presence[Literal["Page", "Chapter"]]`, the
same alias the live progress schema uses, and narrow the browser decoder with
`expectOneOf(unit, ["Page", "Chapter"])` so an unknown unit is a decode defect.
Then replace the lowercasing in `failureProgressLine` with the same exhaustive
switch `progressLine` already owns, and delete the duplicate wording.
No migration is needed: the only writer of `media_source_attempts.progress_unit`
already writes those two values.

## Acceptance

`failureProgressLine` switches exhaustively over the unit with `assertNever` on
the default branch, and a history payload carrying any other unit fails the
browser decoder rather than reaching a reader.
