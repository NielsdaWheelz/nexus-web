# extension javascript is outside the static gate

status: open · origin: 2026-09-23 firefox v1 review · area: extension verification

`scripts/test:46-54` runs frontend checks only from `apps/web`.
`apps/extension` contains standalone javascript and no build/typecheck package;
the sole gate does not establish extension code consistency. source inspection
only; no static command was run during this documentation review.

fix: when packaging the shared chooser and typed extension entrypoints, include
their build/type/lint coverage in the existing fixed `./scripts/test` sequence.
do not create a second gate or reconstruct the retired browser test suite.

acceptance: extension sources participate in the sole static gate; real firefox
login, permissions, capture and interruption behavior has separate manual evidence.
