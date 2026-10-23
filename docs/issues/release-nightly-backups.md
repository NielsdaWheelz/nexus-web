# release nightly backups

status: timer and first live job qualified at deployed `400e7039e`, schema 0312;
expired-archive deletion remains unverified.

the installed units pass `systemd-analyze verify`; the enabled timer schedules
11:00 utc. the manually started canonical service completed on 2026-10-23 with
verified `nightly/2026-10-23/database.dump` evidence and an empty deletion list.
all seven services were observed healthy during the job and the subsequent
`release.py --check` passed against that archive. the backup one-off remained
within its 512-mib cap with no observed oom. build identities and proof are in
the release pr.

the release and nightly jobs have used the real host lock, units and private r2
bucket. no archive has yet expired under the retention rule, so deletion with
the production credentials is still unqualified. do not manufacture expiry or
delete a retained recovery point for this check. after the current archives
age out, inspect the ordinary job's deletion evidence and retained keys.

resolved when a nightly or release prune has deleted an expired archive with its
manifest and receipt, and the bucket holds what the rule keeps.
