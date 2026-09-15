# workspace theme switch crashes after saving

status: open · origin: 2026-09-15 ecbe manual check · area: workspace appearance

## evidence

on deployed `ecbe838ede7a3e85ee83d7c76c34c0383f94c43b`, the user first
confirmed five minutes of paired-reader use, then reported a later workspace
error when switching solar to dark or dark to solar. reloading shows the
selected appearance saved correctly. the browser/app stays open.

through21:56:53 the api retained283.461/320 mib, with zero limit/oom/restart
events. all new application services retained zero oom/restarts. the kernel
read since21:44:40 contains no oom event. this later error is not evidence
of another server oom. exact client exception is not yet captured.

private evidence: `/tmp/nexus-release-255/production-ecbe838e-cutover-memory.jsonl`,
`runtime-ecbe838e-manual-failure.json`, `kernel-ecbe838e-manual-failure.log`.

## follow-up and acceptance

trace the appearance mutation, workspace preference update and theme render
transition. capture the client exception if source evidence does not establish
the cause. fix the owning invariant without masking workspace errors. close
after repeated solar/dark changes keep the current workspace usable and the
selection survives reload. the earlier five-minute reader pass does not cover
this transition.
