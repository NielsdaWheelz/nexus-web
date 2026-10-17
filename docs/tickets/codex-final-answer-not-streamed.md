# codex final answer is not streamed

status: open; separate provider capability
origin: 2026-10-16 compact chat details qualification
area: generation / codex / agent kernel

three real final-only codex runs exposed tools but no `assistant_text_delta`;
answer text arrived at terminal replacement. two subsequent real runs requested
public progress commentary and produced genuine intermediate text events. the
final repaired run proved cursor replay, inspection through progressive prose,
manual release and terminal reconciliation. this does not establish per-token
or progressive final-answer delivery.

`python/uv.lock:495` pins llm-agent-kernel `f922193c718a48cfeecad3165cf6851b55f4e09c`.
its `native.py:496-518` forwards completed commentary to `NativeMessagePort`
and discards `AgentText`; `native_contract.py:354` explicitly defines completed
public commentary. runtime `codex_sdk.py:1282` already exposes native text deltas.
nexus `services/generation/codex.py:247` maps only that commentary callback to
text events; final text returns authoritatively at line 198.

fix: expose an ordered observational text callback at the kernel's public
boundary, then consume it in nexus without duplicating completed commentary.
do not wrap or duplicate the native turn-control protocol inside nexus.

acceptance: a real final-only run produces multiple visible preterminal text
updates, reconnects at the correct cursor without duplication, and retains
authoritative final text. qualify stop, structured output and commentary
composition at their existing owners.
