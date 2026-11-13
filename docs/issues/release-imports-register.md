# release the imports register

wire 23 rides the existing unreleased bump. the production release pointer read
on 2026-11-12 names `c828088a2e97a16d70aec94dc4d7ab90eedd3414`, whose
`python/nexus/api/edge.py` declares wire 21. recheck the released source before
merge; bump once only if wire 23 has since shipped.

migration 0345 creates the empty `import_dismissals` table with non-cascading
user/media references and one row per reader and media. it converts no data.
reassign its number after the actual canonical head at merge.

the owner deploys and signs. use the normal stopped-writer backup, migration,
backend and matching web activation sequence. pair the apk and signed firefox
extension with the selected wire build; pair the email worker if email receiving
is active. old clients cannot use the removed views, fields or query parameters.
do not activate a web build against the old imports routes.

the merge owner deletes the untracked
`docs/issues/import-attention-cannot-be-acknowledged.md` in the original checkout;
this branch cannot remove an untracked file from another checkout.

close after the owner records the matching deployed artifacts and any required
client pairing. chromium qualification does not qualify android or firefox.
