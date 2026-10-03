# vercel env removal reports absence on any failure

status: open · origin: 2026-10-02 cleanup operations audit · area: configuration publication

## problem and evidence

`deploy/vercel/sync-env.sh:329-338` logs "confirmed forbidden ... is absent"
for every nonzero `vercel env rm`, including a timeout, authorization failure,
or provider error. lines 485-488 similarly swallow removal failure and report
"removed" for blank values. command failure is not evidence of absence.

the final pull verification at lines 501-502 checks readable keys, but does
not make the preceding assertions true. operators lose the distinction
between attempted removal and observed provider state.

## fix and acceptance

own removal settlement in this publisher: confirm absence through provider
state or distinguish the provider's absent-key outcome from other failures.
retain final verification. prove local command-failure/absent-key/success
cases without touching production settings; false absence claims must cease.
