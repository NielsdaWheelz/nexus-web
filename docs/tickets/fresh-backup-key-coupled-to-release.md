# fresh backups are coupled to the release sha

status: open; bounded owner correction and real backup/restore proof in progress.
origin: 2026-10-15 book-repair pre-apply preparation on deployed fdd0a3e.
area: database backup identity.

`python/nexus/release_backup.py:264,360` derives both object names solely from
the runtime source sha. reusing the local receipt replays the earlier dump;
a fresh receipt directory refuses the completed object at line 131. the
verified `releases/fdd0a3ecade305082643f6231bbfbcce211b04d7/database.dump`
therefore cannot serve as a newly acquired pre-apply backup. evidence:
campaign `c-sources/finalfdd-preapply-backup-preparation-v1/preparation.json`
(`6b7bde68`) and accepted release backup receipt `51b92e28`.

fix: require an explicit validated archive key on create/verify, retaining
truthful source provenance and the existing evidence/receipt schema. derive
the adjacent recovery manifest from that key. the controller passes its
existing release key; reviewed model-cutover verification passes the reviewed
key. fresh maintenance acquisition requires a new key and local state directory.

acceptance: at one source sha, create two isolated rehearsal backups around a
known database change and restore both correctly. replay the first key without
changing its archive/manifest. refuse a different key with the first receipt
and refuse a completed object without its receipt. retain actual proof and
static checks; no production backup or repair is implied.
