# daily work format cutover

status: implementation locally qualified; installed cutover remains outstanding.
production migration, deployment and physical-device upgrade remain undone.

problem: authored format 5 adds required work metadata. its one-time browser and
android upgrades require an empty outbox. rewriting pending changes would violate
the immutable source command contract.

implementation: `0339_authored_work.py` follows `0338`; both device hosts consume
the shared transactional `UPGRADE_4_TO_5_SQL`. format-4 feed bytes and source
prefixes remain immutable. retain the server actor identity `authored:server:4`:
its suffix identifies the actor, not the storage format. existing release contract is
[local-first writing](release-local-first-writing.md).

required release order:

1. verify exact migration ancestry and paired browser/native assets. current wire
   stays 21: released `android-v0.3.12` uses 20, and the next release's bump to 21
   already occurred. rehearse on the newest production backup before merge.
2. prove every provisioned device has an empty outbox and is caught up. stop old
   writers, take and verify a backup. unavailable devices require explicit owner
   disposition; never assume their pending writing can be discarded.
3. migrate canonical note metadata with `work:null`; preserve bodies, causal
   state, identities, source prefixes and immutable feed bytes. set snapshot
   floors to locked account heads and advance drained replica format admission.
4. deploy paired clients. upgrade note state and all resource/passage projections transactionally only
   with an empty outbox; preserve identity/sequence/cursor. refusal changes nothing.
   old clients/formats stay rejected; do not clear storage or rewrite commands.
5. verify exact schema/assets, installed-host upgrade and offline reopen/reconnect,
   existing writing identity, a task completion and habit date correction. record
   physical-device/live limits separately from disposable proof.

resolved when the paired cutover is qualified and installed devices retain all
old writing and exchange new work facts without compatibility paths. the durable
contract lives in [notes](../modules/notes.md).
