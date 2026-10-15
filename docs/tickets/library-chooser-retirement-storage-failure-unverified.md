# receipt-retirement storage failure lacks live fault proof

status: unverified · origin: 2026-10-15 library chooser qualification · area: web / recovery

problem: native session-storage quota exhaustion proved admission rejects without
sending. it cannot force a retirement write to fail: retirement shrinks/removes
the existing record. no credible browser operation isolated that failure without
replacing storage methods or adding a product seam.

impact: the reviewed stop-and-retry path for a received receipt whose journal
retirement fails has no live fault receipt. this includes atomic create retirement
and dependency release. it is not counted as a passed check.

evidence: `lib/libraries/placementController.tsx` keeps received completions,
stops admission/dispatch on failed retirement, and retries storage before pumping.
the [qualification](../library-chooser-verification.md) records the observed quota
case and exact recovery identities.

prerequisite/fix: obtain a genuine browser storage-denial boundary that can change
after admission. do not monkeypatch a successful response or add production hooks.

acceptance: hold a real receipt, deny its retirement write, and observe no
successor dispatch; restore storage and retry, then observe one durable retirement
before exact successor delivery. repeat for creation/dependency retirement.
