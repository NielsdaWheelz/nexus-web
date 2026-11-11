# expired replay after missing upload bytes remains unqualified

owner disposition, 2026-11-04, recorded in `88e92445b`
([pr 901](https://github.com/NielsdaWheelz/nexus-web/pull/901)): the owner waived
this pre-release qualification for `c6c90343c4324942b310fe7d9b9fadc4f6e5e944`
and confirmed the no-use window. the journey remains unverified; the waiver
does not authorize stopped qualification actions.

`apps/web/src/lib/imports/ingest.ts` retains the original upload session,
generation, filing guard and confirmation. after local expiry with missing
bytes and an unsettled confirmation, retry asks that same confirmation owner
for its authoritative outcome. the [import contract](../modules/imports.md)
owns this behavior; source review is not proof of the exact failure sequence.

resolve with a genuine missing-bytes response after an unanswered confirmation,
natural expiry and unchanged confirmation replay until an authoritative receipt
or refusal. retain original request/outcome evidence and exact cleanup. a
fabricated response, replacement command or neighboring runtime check does not
qualify it. an explicit further owner disposition may bound the remaining gap.
