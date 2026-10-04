# chat failure contract has a parallel browser owner

status: open, source-qualified · origin: 2026-10-04 simplify-02 audit at `5e970dce0515fea7d06d8bd1af48f90d39f1c185` · area: chat transport

`apps/web/src/lib/conversations/types.ts:40-91` repeats the six native failure variants and their rerun literals. `python/nexus/schemas/llm.py:212-254` owns that union; generated `wire.gen.ts:4069,14749` already supplies the same required fields and nullable run/trust projections. individual browser variant exports have no external consumers. `chatFailureContract.ts:1-54` is an unimported decoder: repository imports, symbols and explicit pane/app/extension registrations were traced; there is no wildcard registration or framework entrypoint for it. this is duplicate ownership, not an observed user failure.

preserve genuine projections and policy: `chat_failure.py:51-104` derives failure/rerun eligibility from the durable run; `AssistantMessage.tsx:86,191-196` renders the trust failure with message-level rerun admission. terminal sse carries status; `useChatRunTail.ts:512-517,565-575` reconciles the canonical read for failure/trust data. admission and draft receipts do not store this union.

replace the manual browser union with `NonNullable<Schema<"ChatRunOut">["failure"]>` in its existing owner and delete the unused decoder, approximately 105 authored lines. prerequisite: preserve all six discriminants, required fields, null handling, rerun literals and domain normalization; no producer, provider, receipt or recovery redesign.

acceptance: no old decoder or individual variant callers remain; generated contract and failure presentation are unchanged; `./scripts/test` and focused terminal/trust/card hydration qualification pass. provider execution is not required for this transport-only cut. no runtime qualification has been performed for this proposed slice.
