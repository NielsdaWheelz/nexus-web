# media preview receive ordering has limited direct evidence

source cause fixed: `apps/web/src/app/(authenticated)/media/[id]/annotations.ts`
keeps the newer canonical body when an older acknowledgement reaches its
preview. annotation reads use the shared abortable read/retry owner; receive
failure exposes the existing reconnect action.

private runs20 and24 passed mounted annotation body updates and independent
highlight membership changes. separate canonical-note journeys passed delayed
old probes, superseded body responses and three failed reads followed by
reconnect to the same committed version (`/tmp/nexus-writing-live-20.log`,
`/tmp/nexus-writing-live-24.log`; archived `writing-receive-races.spec.ts` and
`writing-receive-retry.spec.ts`). no continuing preview rollback was observed.

remaining uncertainty: no case forced an older acknowledgement after a newer
body read, or exhausted reads followed by reconnect, directly through the media
preview adapter. the separate stale-response and reconnect cases covered the
canonical note owner. ordinary annotation convergence is proven; those exact
adapter interleavings remain untested. close when existing receive evidence
covers that boundary without a whole-media body reread. no new retry owner or
verification framework is required.
