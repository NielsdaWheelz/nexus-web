# browser queue refused replay loses unknown

problem at dabdec901ef5a754506a5e3deaabaa961e66e020: browserSession.ts97-104 retains unanswered pending only when transportOf(cause) is not Refused; generic409 Refused clears original pending/frozenBody/unanswered before GET.

impact: an earlier possibly-late write loses its held uncertainty and exact replay bytes; later edits become enabled without a proven outcome. this exceeds the separate Changed-copy defect.

counterexample: initial PUT is still awaiting its viewer/session lock at expected r; reply times out. explicit replay gets edge.py93-99 DatabaseBusyError/E_RESOURCE_CONFLICT. catch clears original pending; GET reads unchanged r. initial PUT later acquires lock and commits r+1.

owner contract: playback_sessions.py43-134 locks viewer/session. nonterminal equal absolute state is inert success121-122; otherwise expected revision must match123-124. terminal equal queue also requires natural_end_is_settled109-111, so queue equality alone cannot prove terminal acceptance. same revision GET (including null-create baseline) does not permanently fence the late original.

minimal repair: preserve original bytes, pending previous and Hold on any refused replay unless an accepted identical response or authoritative permanent fence proves settlement. distinct session id / advanced incompatible revision may prove old command cannot later apply; terminal postcondition must not be guessed from queue equality. no new protocol or storage required. ordinary first refusal can keep existing retirement and reread workflow.

resolved when delayed-original + generic409 replay + same-head GET retains uncertainty and exact bytes until real settlement, while true permanent fence safely resolves without replay. root owns adoption; independent source adjudication only, no lab.
