# current model catalog production cutover

implementation is qualified in the isolated catalog branch; production activation
remains pending. contracts live in [llms](../modules/llms.md), exact provider/kernel
revisions in `python/uv.lock`, and native `0.165.0` in `node/codex/bun.lock`.

- use the existing [release procedure](../../deployment.md) to stop admissions
  and background producers, drain queued/running generations, and verify zero
  nonterminal work. the stranded-run rehearsal proves refusal, not production
  drain completion. never rewrite admitted specs, receipts or saved history.
- deploy the compatible host/api/worker/web cohort before reopening admissions.
  the host uses the locked npm launcher and contained catalog v2; the provider
  client uses agent catalog v3 and api catalog v5. old clients/hosts are rejected;
  no version bypass or credential copying. this adds no migration or wire bump;
  the paired controls release still requires wire 17.
- verify deployed catalog health, current offerings, ordinary-worker chat with
  the sol 6.1/xhigh seed, strict-json oracle, and preserved historical presentation.
  use the existing host account and isolation contract. production account refresh
  remains [separately unqualified](codex-auth-refresh-not-qualified.md).
- keep [both xai models omitted](model-catalog-xai-live-access.md) until access
  and their complete live contract qualify. anthropic bounded synthetic checks
  are authorized under standard retention; the earlier refusal was reversed.

proof and exact tested source cohorts belong in the pr. delete this release
record after the deployed cohort and drain are verified; laboratory success does
not establish production activation.
