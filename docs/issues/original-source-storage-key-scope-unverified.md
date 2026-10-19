# original-source storage credential scope is unverified

status: open; outside retained-book repair
origin: 2026-10-16 book coordinator capability review
area: storage / runtime privilege

book inspection reuses the existing production object credential. accepted
reads and the pinned reader/contributor paths establish read authorization and
read-only operations; they do not establish that the credential cannot write.
do not describe this as a policy-enforced read-only storage credential.

evidence: private campaign
`c-sources/live-original-source-authority-readiness-v1.json`, sha256
`01f061844d9ae45d91e0e241e4d3d999bf3c59ef873dff02fac3ffbe32b44503`.
the retained profile derivation explicitly says existing production credentials,
operator only reads. portrait's separate bucket-scoped credential is unrelated.

fix: obtain account-side scope evidence and use a credential restricted to
reading the production media bucket for standalone inspection. this is not an
additional gate on the authorized, pinned read paths in the current plan.

acceptance: account policy proves the reader credential's read-only bucket
scope, and ordinary source inspection succeeds with it. no production test
write is required.
