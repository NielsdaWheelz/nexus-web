# qualify expired replay after missing bytes

owner-accepted source review qualifies the shared upload repair for this rebuild. the exact missing-bytes-after-unanswered-confirmation followed by natural expiry remains required before release; neighboring runtime controls do not execute it.

`apps/web/src/lib/imports/ingest.ts` retains the original session, generation, filing guard and confirmation command. when bytes are unavailable after local expiry and confirmation remains unsettled, retry asks that original confirmation owner for its authoritative outcome instead of stranding the attempt locally.

resolve this release gate with a legitimate actual missing-bytes response after a lost confirmation, natural expiry and ordinary unchanged confirmation replay until an authoritative receipt or refusal. preserve original request/outcome evidence and exact cleanup. no fabricated response/status, new command or observed-red claim may replace the real journey.
