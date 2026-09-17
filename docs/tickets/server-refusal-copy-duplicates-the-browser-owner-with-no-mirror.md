# stopped-import refusal duplicates browser copy

status: open
origin: 2026-09-09 imports cutover, oi-027 residual review; updated 2026-09-17
area: source-ingest error presentation

`python/nexus/services/media_source_ingest.py:1834–1839` repeats the stopped-import
title, explanation, and repair-action label composed in
`apps/web/src/lib/media/mediaErrorMessage.ts:105–112`. changing the browser
wording can leave the server's diagnostic message claiming a stale action name.
the 2026-09-17 testing reset retires the proposed cross-language copy assertion;
it does not remove the duplicate presentation responsibility.

prerequisites: none. make the server message diagnostic and let the browser own
reader-facing action wording. do not create a copy-comparison test.

acceptance: the server reports the refused state without restating browser copy;
the browser still offers the appropriate recovery action.
