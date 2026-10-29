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
  the paired controls release still requires wire 17 and its account-memory
  migration 0325. retired remembered choices remain unchanged until explicit
  reselection; accepted-request replay never updates that memory.
- verify deployed catalog health, current offerings, ordinary-worker chat with
  the sol 6.1/xhigh seed, strict-json oracle, and preserved historical presentation.
  use the existing host account and isolation contract. production account refresh
  remains [separately unqualified](codex-auth-refresh-not-qualified.md).
- keep [both xai models omitted](model-catalog-xai-live-access.md) until access
  and their complete live contract qualify. anthropic bounded synthetic checks
  are authorized under standard retention; the earlier refusal was reversed.

release review at `3b32fcc4e`: the previous drain requirement lacked an implemented
operator procedure. the previous `deploy/hetzner/release.py:758` stopped processes;
`apps/worker/main.py:35-46` requests shutdown, while
`python/nexus/jobs/worker.py:55-59,182-186` schedules periodic work and can return
released work to the queue. clean exits do not prove zero nonterminal generations.
no general admission/producer pause was found; the existing chat cancel route
handles individual runs. the controller now has a final stopped-writer census
and exact-id `--restore-original` recovery before candidate mutation. before
production release, perform the concrete [quiescence procedure](../../deployment.md#refusal-recovery).
prove no new admissions and zero queued/running generations before migration;
do not manufacture completion by rewriting queue rows or accepted requests.

follow-up census at deployed `3d81ef45`/0317 found 21 complete chats, zero open
llm calls and no pending/failed/running jobs. this is a point observation, not
release proof. prefer a final read-only quiescence check after the existing
verified api/worker/codex stop and before backup/migration; with no live producer,
zero is stable. any residual accepted work refuses without mutation. qualify
the old-cohort restoration/settlement path before relying on this procedure.
144 historical running tool receipts belong to already-failed generations and
are tracked [separately](terminal-generations-retain-running-tool-receipts.md).
no general admission/pause subsystem is yet justified by the observed workload.
refusal recovery preserves original stopped container/image ids and untouched
host inputs, with a durable two-state record. original containers retain their
environment and immutable bind paths even if `current.env` names candidate
configuration. recovery starts that exact cohort only while postgres identity,
revision and host inputs are unchanged; candidate mutation invalidates it before
installation and keeps it invalid across failed forward retries. do not recreate
the old cohort from candidate compose or use an old deployment script.
forward continuation retains migration-created or newly admitted compatible work
only for the exact authorized candidate manifest/config, unchanged database
identity and an original-to-target revision. any other target must pass strict
zero before rebinding; no row or counter is cleared to make that pass.

proof and exact tested source cohorts belong in the pr. delete this release
record after the deployed cohort and drain are verified; laboratory success does
not establish production activation.
