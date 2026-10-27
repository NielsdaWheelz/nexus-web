# unperformed pre-reply status observation

`apps/web/src/lib/authored/sync.ts` starts a fresh synchronization owner with no observed head;
current requires a known remote watermark. this source invariant is reviewed.
no current false-current defect is established.

there is no separate initial-frame recording before the first remote reply.
ordinary offline cold-open proof does not establish that exact observation.
a fresh-process local open with transport held, usable writing and a non-current
status until an actual head arrives would close this optional probe.
