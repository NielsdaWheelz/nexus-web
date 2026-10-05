# web rate-limit copy outlives the deleted limiter

status: open · origin: 2026-09-28, cleanup/delete-rate-limiter (pr-04, claude session) · area:
chat admission / oracle web

migration 0248 deletes the postgres rate limiter. once that backend ships, the
web keeps two oracle arms no backend can reach:

- `apps/web/src/app/(authenticated)/oracle/OracleLandingPaneBody.tsx:38-44`
  ("The oracle is busy").
- `apps/web/src/app/(authenticated)/oracle/[readingId]/OracleReadingPaneBody.tsx:122-128`
  (`oracleRetryErrorMessage`, "The oracle is busy"): the retry POSTs
  `/api/oracle/readings`, the same `create_reading`.

the two chat arms (`E_RATE_LIMITED` in the admission rejection list,
`E_RATE_LIMITER_UNAVAILABLE` in the composer) went with the 2026-10-04 chat
rewrite: chat rejection codes are now the generated wire type, so they follow
python's `ChatAdmissionRejectionCode` with no browser list.

they were kept on the belief that the web deploys before the backend. correction (2026-09-28): the premise was wrong. merging deploys nothing, and `deploy/hetzner/deploy.sh` releases web and backend at one sha, so the new web never talks to the old backend. the arms guard nothing and can go now.

`OracleReadingPaneBody.tsx:370` stays: it maps the persisted
`OracleReadingFailureCode`, which keeps its historical `E_RATE_LIMITED`.

prerequisite: none.

fix: delete the two oracle arms.

acceptance: `rg E_RATE_LIMITER_UNAVAILABLE apps/web/src` finds nothing, and
neither oracle create call site (landing submit, reading-pane retry) has an
`E_RATE_LIMITED` arm.
