# codex background write instruction ignored

status: open · origin: 2026-09-27 shell cutover live qualification · area: background generation

## problem and evidence

on backend `d6b06991c`, note dossier build `5a284dec-9f3c-4136-90ae-419f17713922` completed a cited revision but made no `nexus.note.create` call. postgres confirmed the requested note marker in the persisted user instruction and `CodexShell` authority on the generation. the ledger recorded zero generation-api positions and effects. receipt sha256 `a58ef597917715083370856fb386df142e9f034d846abcd17e9c677ba2756d15`. the follow-up job was quota-paused before dispatch, so it provides no contrary evidence.

## prerequisite and acceptance

inspect the actual background prompt and shell instructions. determine whether the missing call reflects prompt composition, model behavior, or an execution boundary. repair the responsible layer if defective. on the final merged source, prove a model-originated background create, list, and supported undo with persisted positions and effects; qualify all twelve roles with real subject fixtures. a valid strict-json revision alone is insufficient.
