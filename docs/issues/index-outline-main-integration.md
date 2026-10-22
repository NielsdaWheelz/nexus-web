# index/outline needs integration with current main

problem: this implementation targets approved spec base `832d8e4b8`; remote main
advanced to `2ae785ba6` during the work. publishing it as merge-ready would conceal
incompatible source and migration owners.

exact overlaps include `lib/notes/{texts,useOutlineSession}.ts`, note/title/editor
callers, resource graph commands and `components/media/MediaIdentity.tsx`. main
adds the account-scoped writing journal (`395679781`), shared media controls
(`6685ea4fb`), a squashed 0306 baseline (`e6507d5d5`) and
`0307_authored_identities.py`; this branch also adds migration 0307.

impact: the isolated branch's static/browser/migration proof does not qualify
an integrated tree. main's storage/recovery contract also differs from the pinned
spec's memory-only draft rule.

resolve the delivery-base choice with the owner. to integrate: preserve current
writing/recovery/media owners, cut this migration after actual head, regenerate
wire and rerun the affected real live boundaries plus the static gate. keep the
owned disposable cases until that qualification finishes. resolved when the
integrated source has one migration head, preserves both contracts and passes
those checks; no blanket merge/deployment readiness follows from baseline proof.
