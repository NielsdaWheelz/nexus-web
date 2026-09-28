# unraised api error codes kept alive by web switch arms

status: open · origin: 2026-09-27, pr-02 backend dead-code sweep (claude session) · area:
errors / web ingestion and media pane feedback

`ApiErrorCode.E_UPLOAD_VERIFICATION_IN_PROGRESS` (`python/nexus/errors.py:106`)
and `ApiErrorCode.E_CHAPTER_NOT_FOUND` (`python/nexus/errors.py:163`) are raised
nowhere in the backend. web still switches on them:
`apps/web/src/lib/media/ingestionClient.ts:159,192,209` and
`apps/web/src/app/(authenticated)/media/[id]/mediaPaneFeedback.ts:69`. the arms
are unreachable copy, and the members look like a live contract.

fix: delete the web arms and the two enum members together. the backend never
emits either code, so deploy order is free.

acceptance: `rg 'E_UPLOAD_VERIFICATION_IN_PROGRESS|E_CHAPTER_NOT_FOUND'` finds
nothing.
