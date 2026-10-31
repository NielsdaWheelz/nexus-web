# codex final answer is not streamed

open provider capability; no dependency change or streaming repair is selected.
real final-only codex runs delivered answer text at terminal replacement;
commentary runs proved intermediate events and replay, not progressive final text.
on 37d the user likewise saw text appear all at once and reported luna, but the
actual route is UNCONFIRMED. this is not an exact diagnosis of that request.

installed/locked kernel `bc087b60e73b61c2382402295aa439306ad97552`
(`python/uv.lock:495–497`) forwards completed commentary through
`NativeMessagePort.record` and discards `AgentText` (`native.py:496–518`,
`native_contract.py:354–356`). provider-runtime `codex_sdk.py:1291–1295` emits
those deltas; nexus `services/generation/codex.py:244–248` forwards commentary
and returns final text after completion at lines 196–207.

repair belongs at the kernel's public observational-text boundary and nexus
consumer, preserving order and avoiding duplicate commentary or native turn
control. resolve with progressive final-only delivery, correct reconnect cursor
and authoritative final text, preserving structured-output/commentary semantics.

ordinary same-model Stop BEFORE text passed on 37d: “ok that stopped normally”.
that cancellation observation is complete and independent of final-text delivery;
no additional cancellation case is selected. full earlier receipts remain private.
