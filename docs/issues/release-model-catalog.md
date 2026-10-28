# current model catalog release prerequisites

implementation is isolated on `codex/current-model-catalog`; release qualification
is incomplete. current source contracts live in [llms](../modules/llms.md).

- freeze exact llm-calling, compatible kernel/sdk, host binary and nexus revisions.
  resolve [host qualification](codex-containment-host-upgrade.md) with the current
  stable candidate when implementation begins; no floating pin, version-only
  bypass, shared-daemon restart or credential copying.
- enumerate every target model/configuration and its actual live result. on
  2026-10-28 the owner allowed bounded anthropic checks under standard retention
  and use of production keys. xai remains unavailable; the owner approved
  [both model omissions](model-catalog-xai-live-access.md). qualify every
  permitted cell; never substitute an old model or count an omission as a pass.
- qualify an isolated full candidate cohort, then freeze the published subset.
  review omitted rows and unchanged fingerprints/execution code before carrying
  candidate evidence forward; perform final inventory and integration checks on
  the exact released cohort. no runtime test bypass or qualification flag.
- verify the installed dependencies match the reviewed locks. the audit found
  the local virtualenv at `602a5604` while nexus pins `2ab70c1f`; it cannot qualify
  that pin. use an isolated, correctly installed checkout.
- use the existing release owner's controls to stop new admissions/background
  producers, drain queued/running generations, and confirm zero nonterminal work.
  deploy the compatible host/api/worker/web cohort before reopening admissions.
  do not rewrite saved specs or completed history. bind operator commands to the
  actual deployment when preparing the release; do not invent a second controller.
- observe catalog health, containment, a live ordinary-worker generation and the
  changed seed/oracle. confirm old selections cannot dispatch, history is intact,
  and every published addition has its required proof. no migration or wire bump
  is implied; unrelated concurrent changes keep their own release requirements.
- prove old→new history/receipt preservation, stranded queued-run refusal and
  drain completion through existing release primitives. an unavailable rehearsal
  is a blocking verification issue; partial model publication does not waive it.

resolved when the exact published cohort passes these checks and omissions have
their own honest unresolved records. source/docs review is not release proof.
