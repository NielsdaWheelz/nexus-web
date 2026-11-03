# browser queue conflict reason

problem at dabdec901ef5a754506a5e3deaabaa961e66e020: browserSession.ts108-112 maps every answered409 to QueueCommandError Changed after read; queue.ts28 says `couldn’t change the queue. it changed meanwhile.`.

impact/counterexample: edge.py93-99 owned database transaction busy emits E_RESOURCE_CONFLICT with unchanged queue. reread succeeds with same queue/revision, yet copy claims movement. playback_sessions.py25-26 uses same code for actual queue conflict, so code alone cannot distinguish.

minimal proposed fix: for a first known refusal, preserve pending retirement, reread and no reapplication; throw Refused (fact alone) for generic409, or Changed only when reread proves different queue/revision. keep local pre-dispatch/native typed Changed reasons, whose actual captured authority mismatch is proved.

resolved when same-queue busy409 asserts no change and real revision mismatch remains safe. root owns repository adoption; no lab here.

prior unknown is a separate lifetime defect: see [retained queue uncertainty](browser-queue-refused-replay-loses-unknown.md). a later refusal alone cannot retire that original command.
