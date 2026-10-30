# named suggestion refresh fails before publication

integrated source `77e47d986370332eee2f25d743aaab4c68f8c441`, disposable actual
2gib qualification `dc6a92238e0a`: named job
`01a18ada-8a0a-7f86-86e1-a5c96c5b48da`, execution
`0f96818f-9896-48d5-8b24-d776ccf880d8`, settled `failed`, attempt 1/3,
`E_WORKER_HANDLER_FAILED`, no publication. its durable saved error is exactly
`SearchBudgetExpired: Search computation deadline expired`. no sqlstate or
responsible traceback frame was stored in that error. the private carrier
asserted only after this canonical failed settlement.

this blocks useful completion of the named publication and remaining backend
qualification. the historical recovered global job succeeded separately; it is
not this failure. production was untouched. exact read/identity proof and raw
error remain private in `.nexus-local/native-capacity-integrated77e47.private/`
(`dc6a-exact-named-job.*`); no reset or requeue was performed.

the repair derives both background search read allowances from the configured
child wall allowance instead of 30 seconds. the earlier whole-handler watchdog
remains authoritative; foreground/transport clocks, admission, attempts and
retirement owners are unchanged. source/static review does not close this issue:
the existing failed job retains attempt 1/3 for normal retry after integration.

resolved when the responsible computation-deadline behavior is reconciled with
the accepted slow, complete ranking contract and this existing work completes
normally with exact retrieval semantics, approved caps and failed history
preserved. no arbitrary replacement deadline or cause beyond the saved error
is established here.
