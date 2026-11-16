# capture confirmation exceeds the client deadline

on 2026-11-16, backend `b666d936f` and installed firefox extension 1.1.4
completed the first article confirmation in 34,083.67 ms. the extension's
30-second deadline (`apps/web/src/extension/background.ts:20,338`) expired first,
leaving “not sure this save finished.” the api subsequently returned 200 and the
single source attempt and ingest job succeeded. no permission or wire failure
appeared. request: `e0fe87f3-ce1c-4e45-bf4c-9904bf99a886`.

the source/job identities were minted by 17:59:08.053 utc; the publication event
was minted at 17:59:40.796. this bounds the long interval inside the existing
enqueue/placement/publication work in `media_upload_sessions.py:402–497`, after
storage validation. the exact slow statement or lock is unknown: statement and
lock-wait logging were off and pg_stat_statements was absent. these application
owners are unchanged from the previous backend `833eb09a7`; a hosting cause has
not been established. do not label this a cold-cache diagnosis.

one explicit “check again” retained the same session/generation and returned its
published receipt in 44.31 ms; the database still contained one session, one
source attempt and one ingest job with one execution. this is the safe recovery
for the unanswered confirmation. a separate extension receipt-decoder defect
prevented the later item display; it does not change the admission evidence.

follow-up: measure the bounded publication path on representative restored data,
then fix the responsible shared query or lock owner. preserve atomic admission,
visibility and exact receipt replay; do not substitute a larger timeout. resolved
when ordinary first confirmation fits the existing deadline under representative
host conditions and unanswered-confirmation recovery returns the same identities
without another source attempt or ingest job.
