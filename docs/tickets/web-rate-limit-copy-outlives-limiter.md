# web rate-limit copy outlives the deleted limiter

status: open · origin: 2026-09-28, cleanup/delete-rate-limiter (pr-04, claude session) · area:
chat admission / oracle web

migration 0248 deletes the postgres rate limiter. once that backend ships, the
web keeps four arms no backend can reach:

- `apps/web/src/lib/conversations/chatAdmission.ts:17` (`REJECTION_CODES`
  entry `E_RATE_LIMITED`) and `:126-127` ("Too many messages").
- `apps/web/src/components/chat/ChatComposer.tsx:459` (the silent return on
  `E_RATE_LIMITER_UNAVAILABLE`).
- `apps/web/src/app/(authenticated)/oracle/OracleLandingPaneBody.tsx:38-44`
  ("The oracle is busy").
- `apps/web/src/app/(authenticated)/oracle/[readingId]/OracleReadingPaneBody.tsx:122-128`
  (`oracleRetryErrorMessage`, "The oracle is busy"): the retry POSTs
  `/api/oracle/readings` (`:440`), the same `create_reading`.

they stay until then because the web deploys before the backend: the old
backend still emits both codes, and `expectOneOf` (`chatAdmission.ts:101-104`)
throws on an unknown rejection code.

`OracleReadingPaneBody.tsx:370` stays: it maps the persisted
`OracleReadingFailureCode`, which keeps its historical `E_RATE_LIMITED`.

prerequisite: a backend release that includes 0248.

fix: delete the four arms; `REJECTION_CODES` then equals python's
`ChatAdmissionRejectionCode`.

acceptance: `rg E_RATE_LIMITER_UNAVAILABLE apps/web/src` finds nothing,
`REJECTION_CODES` matches `ChatAdmissionRejectionCode`
(`python/nexus/schemas/conversation.py`), and neither oracle create call site
(landing submit, reading-pane retry) has an `E_RATE_LIMITED` arm.
