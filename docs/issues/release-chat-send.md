# chat send hard cutover

status: implemented on `codex/chat-send`; qualification and paired release pending.
contracts: [chat](../modules/chat.md), [resource references](../modules/resource-references.md).

wire 19 already contains the first breaking change after released wire 18. pair
api, generated web wire and android assets; reject old clients without translating
pending commands. finish or copy tab-local questions before reload or cutover.

schema 0330 follows 0329. it backfills account deletion fences, indexes native
quotes and derives table boundaries from retained canonical publications. it
refuses inconsistent retained text; historical quote words and run inputs stay
unchanged. use the existing stopped-writer, verified-backup and exact-head deploy
procedure. migration and bounded preparation must qualify on a restored real
backup under existing memory limits before activation. proof belongs in the pr.

after paired deployment, run one owned passage → chat → answer → source smoke,
check error telemetry, then remove its temporary artifacts. no deliberate
production oom or destructive failure injection. preserve any separate,
unattributed crash record.

resolved when paired clients reject old wire, send/recover without duplication,
retain source discovery, and pass the scoped live smoke.
