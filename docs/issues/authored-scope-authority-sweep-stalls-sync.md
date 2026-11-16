# scope authority sweeps stall authored synchronization

on backend `b666d936f`, 2026-11-16 19:08–19:13 utc, ordinary firefox/android
catch-up produced 17 `/authored/scope-inputs` 503 `E_DATABASE_BUSY` responses and
three `/authored/changes` pool-exhaustion refusals. postgres had no new oom/kill
after its 2 gib increase. the acknowledged note text and causal changes survived;
the observed row disappearance was a separate driver-issued indent command.

backend 27057 held an ordinary read transaction for 7m55s while executing fragment
visibility sql, without lock blockers. `services/authored/scope.py:318–343`
authorizes up to 100 active refs individually, rebuilding capture visibility for
each fragment after computing the scope revision. `api/routes/authored.py:137–153`
holds the one bulk permit and checkout through that work; waiting requests refuse
after five seconds. the client awaits this scope lane with upload/download and
reports its failure as “notes aren’t syncing” even after note bytes are acknowledged.

repair the bounded authority sweep at its shared visibility owner, preserving
exact media/library/capture permissions, missing-ref behavior, request order and
duplicates. qualify equivalent decisions and representative stored-data work;
do not raise pools/timeouts or replace per-ref scans with one unbounded corpus
scan. request-cancellation ownership remains a separate
[issue](api-sync-work-outlives-request-cancellation.md).

the fused-read candidate reuses the revision's existing authority relations.
its isolated restored-corpus check matched the old revision and authority
decisions for 99 allowed, denied, missing and repeated refs; malformed and
unsupported refs were refused identically. the old revision took 10.88 seconds;
the new complete status took 13.97 seconds in one statement, below the existing
30-second client deadline. this
removes the serial authority sweep; it does not remove the revision's corpus
work or qualify deployed catch-up. an earlier live diagnostic stopped in the
old revision at its narrower ten-second bound before evaluating the candidate.

close after the deployed owner lets ordinary firefox/android catch-up complete
without the serial authority queries or resulting pool starvation. preserve
acknowledged note bytes and source prefixes; request cancellation and the
remaining corpus cost must not be disguised by larger pools or timeouts.
