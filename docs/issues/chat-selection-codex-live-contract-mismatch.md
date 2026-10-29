# codex selection live qualification

the approved selection change keeps the existing runtime/model pins. its live
codex checks are blocked by a separately upgraded shared lab host; fake-provider
transport and memory checks do not prove live model success.

2026-10-28: `./scripts/lab-codex status` initially reported a compatible 0.160.0
host. later preflight observed 0.165.0, contained catalog v2 and
`provider-runtime.agent-model-catalog.v3`; this checkout requires 0.160.0,
contained catalog v1 and backend contract v2. `python/scripts/lab_codex.py`
rejects the mismatch and refuses a shared-host downgrade. no live codex request
was sent and no shared-host administration was attempted.

resolve with an approved compatible live verification environment, or after the
separate catalog/runtime upgrade is integrated and qualified. through the real
composer, complete codex sol/xhigh and astra/max runs; the visible choice,
request, saved selection and remembered account choice must agree. do not infer
success from credentials, fake text or an unstarted lab.
