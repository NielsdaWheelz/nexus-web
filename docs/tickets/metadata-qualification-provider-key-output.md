# reported provider key exposure during metadata qualification

status: open
origin: 2026-10-13; metadata implementation, reviewer `/root/runtime_evidence`
area: local provider credentials

the reviewer’s retained handoff records a raw
`cat /tmp/nexus-metadata-20261013-impl/worker.override.yml` whose tool output
included local openai/brave credential values. the reviewer reported this after
compaction; the exact call id/time is unavailable, and root did not independently
inspect that receipt. preserve this distinction; do not reproduce the values.

impact: treat the two provider keys as exposed through retained tool output.
the file was populated from the existing local `.env`, not deployment config.

prerequisite: credential owner identifies affected bindings and accounts.
revoke/replace both keys, update their actual consumers, and assess access to the
retained receipt. key administration and production binding changes are outside
the isolated metadata campaign.

acceptance: owner confirms revocation/replacement and affected-binding checks;
subsequent inspection exposes only names/presence. no credential values belong
in this ticket, receipts, commits or review messages.
